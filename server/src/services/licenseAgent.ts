import { getDb } from '../db/index';
import type { Vendor } from './licenseSources';

/**
 * License Reclaim engine.
 *
 * Reconciles the active roster (hr_employees) against the software-license seat inventory
 * (license_seats). Any seat assigned to someone who is TERMINATED, or not on the active roster
 * at all, is a RECLAIMABLE license - the per-seat monthly cost is recoverable spend. Reclaim is
 * human-gated: proposeReclaim() drafts a proposal, approveReclaim() is the human approval that
 * authorizes the offboard/deprovision task. Nothing here ever cancels a license automatically.
 */

/** The five independent vendors, with display labels and the default product line. */
export const VENDORS: { key: Vendor; label: string; product: string }[] = [
  { key: 'adobe', label: 'Adobe', product: 'Creative Cloud All Apps' },
  { key: 'bluebeam', label: 'Bluebeam', product: 'Bluebeam Revu' },
  { key: 'autocad', label: 'AutoCAD', product: 'AutoCAD (Autodesk)' },
  { key: 'hydrocad', label: 'HydroCAD', product: 'HydroCAD' },
  { key: 'microsoft', label: 'Microsoft 365', product: 'Microsoft 365 E3' },
];

export function vendorLabel(key: string): string {
  const v = VENDORS.find((x) => x.key === key);
  return v ? v.label : key;
}

export interface LicenseSeat {
  id: number;
  vendor: string;
  product: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  cost_monthly: number;
  assigned_at: string | null;
  source: string;
}

export interface HrEmployee {
  id: number;
  full_name: string;
  email: string | null;
  department: string | null;
  title: string | null;
  status: string;
  hired_at: string | null;
  terminated_at: string | null;
  source: string;
}

export interface ReclaimableSeat {
  seat_id: number;
  vendor: string;
  vendor_label: string;
  product: string | null;
  assignee_email: string | null;
  assignee_name: string;
  department: string | null;
  reason_kind: 'terminated' | 'off_roster';
  terminated_at: string | null;
  cost_monthly: number;
  reclaim_status: string | null; // proposed|approved|reclaimed, or null (not yet flagged)
  reclaim_id: number | null;
}

export interface VendorBreakdown {
  vendor: string;
  label: string;
  seats: number;
  assigned: number;
  reclaimable: number;
  savings_monthly: number;
  savings_annual: number;
}

/** Lowercased active-roster email set (the source of truth for "still works here"). */
function activeEmailSet(): Set<string> {
  const rows = getDb()
    .prepare(`SELECT email FROM hr_employees WHERE status = 'active' AND email IS NOT NULL`)
    .all() as { email: string }[];
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

/** Look up an employee by email (case-insensitive). */
function employeeByEmail(): Map<string, HrEmployee> {
  const rows = getDb()
    .prepare(`SELECT * FROM hr_employees WHERE email IS NOT NULL`)
    .all() as HrEmployee[];
  const m = new Map<string, HrEmployee>();
  for (const r of rows) if (r.email) m.set(r.email.toLowerCase(), r);
  return m;
}

/** The reclaim row (if any) currently open for each seat. */
function reclaimsBySeat(): Map<number, { id: number; status: string }> {
  const rows = getDb()
    .prepare(
      `SELECT id, seat_id, status FROM license_reclaims WHERE status IN ('proposed','approved','reclaimed')
       ORDER BY id DESC`
    )
    .all() as { id: number; seat_id: number; status: string }[];
  const m = new Map<number, { id: number; status: string }>();
  for (const r of rows) if (!m.has(r.seat_id)) m.set(r.seat_id, { id: r.id, status: r.status });
  return m;
}

/**
 * The core reconciliation. Returns every reclaimable seat (with the ex-employee context),
 * a per-vendor breakdown across ALL seats, and the savings totals.
 */
export function reconcile(): {
  reclaimable: ReclaimableSeat[];
  byVendor: VendorBreakdown[];
  totals: { seats: number; reclaimableSeats: number; savingsMonthly: number; savingsAnnual: number };
} {
  const db = getDb();
  const seats = db.prepare(`SELECT * FROM license_seats`).all() as LicenseSeat[];
  const active = activeEmailSet();
  const byEmail = employeeByEmail();
  const openReclaims = reclaimsBySeat();

  const reclaimable: ReclaimableSeat[] = [];
  // seed the per-vendor tallies for all five vendors so every vendor renders even at zero
  const vb = new Map<string, VendorBreakdown>();
  for (const v of VENDORS)
    vb.set(v.key, {
      vendor: v.key,
      label: v.label,
      seats: 0,
      assigned: 0,
      reclaimable: 0,
      savings_monthly: 0,
      savings_annual: 0,
    });

  for (const seat of seats) {
    const row =
      vb.get(seat.vendor) ||
      (vb.set(seat.vendor, {
        vendor: seat.vendor,
        label: vendorLabel(seat.vendor),
        seats: 0,
        assigned: 0,
        reclaimable: 0,
        savings_monthly: 0,
        savings_annual: 0,
      }),
      vb.get(seat.vendor)!);
    row.seats += 1;
    if (seat.assignee_email) row.assigned += 1;

    const email = seat.assignee_email ? seat.assignee_email.toLowerCase() : '';
    if (!email) continue; // an unassigned seat is spare inventory, not a reclaim target
    if (active.has(email)) continue; // person still works here -> keep the seat

    const emp = byEmail.get(email);
    const reasonKind: 'terminated' | 'off_roster' = emp ? 'terminated' : 'off_roster';
    const open = openReclaims.get(seat.id) || null;

    reclaimable.push({
      seat_id: seat.id,
      vendor: seat.vendor,
      vendor_label: vendorLabel(seat.vendor),
      product: seat.product,
      assignee_email: seat.assignee_email,
      assignee_name: seat.assignee_name || (emp ? emp.full_name : seat.assignee_email || 'Unknown'),
      department: emp ? emp.department : null,
      reason_kind: reasonKind,
      terminated_at: emp ? emp.terminated_at : null,
      cost_monthly: seat.cost_monthly || 0,
      reclaim_status: open ? open.status : null,
      reclaim_id: open ? open.id : null,
    });

    row.reclaimable += 1;
    row.savings_monthly += seat.cost_monthly || 0;
  }

  // finalize annualized savings per vendor
  for (const row of vb.values()) row.savings_annual = row.savings_monthly * 12;

  // reclaimable sorted by biggest single-seat cost first (the fastest wins on top)
  reclaimable.sort((a, b) => b.cost_monthly - a.cost_monthly);

  const savingsMonthly = reclaimable.reduce((s, r) => s + r.cost_monthly, 0);
  const byVendor = VENDORS.map((v) => vb.get(v.key)!).concat(
    // any non-standard vendor rows that somehow exist, appended after the five
    [...vb.values()].filter((r) => !VENDORS.some((v) => v.key === r.vendor))
  );

  return {
    reclaimable,
    byVendor,
    totals: {
      seats: seats.length,
      reclaimableSeats: reclaimable.length,
      savingsMonthly,
      savingsAnnual: savingsMonthly * 12,
    },
  };
}

export interface LicenseSummary {
  totalSeats: number;
  assignedSeats: number;
  reclaimableSeats: number;
  spendMonthly: number; // $ under management across every seat
  spendAnnual: number;
  savingsMonthly: number; // $ at risk / recoverable
  savingsAnnual: number;
  activeEmployees: number;
  terminatedEmployees: number;
}

/** Totals + counts for the KPI strip. */
export function getLicenseSummary(): LicenseSummary {
  const db = getDb();
  const seats = db.prepare(`SELECT cost_monthly, assignee_email FROM license_seats`).all() as {
    cost_monthly: number;
    assignee_email: string | null;
  }[];
  const spendMonthly = seats.reduce((s, r) => s + (r.cost_monthly || 0), 0);
  const assignedSeats = seats.filter((r) => !!r.assignee_email).length;
  const rec = reconcile();
  const emp = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status='terminated' THEN 1 ELSE 0 END) AS terminated
       FROM hr_employees`
    )
    .get() as { active: number | null; terminated: number | null };
  return {
    totalSeats: seats.length,
    assignedSeats,
    reclaimableSeats: rec.totals.reclaimableSeats,
    spendMonthly,
    spendAnnual: spendMonthly * 12,
    savingsMonthly: rec.totals.savingsMonthly,
    savingsAnnual: rec.totals.savingsAnnual,
    activeEmployees: emp.active || 0,
    terminatedEmployees: emp.terminated || 0,
  };
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * Propose a reclaim for a seat (the DRAFT). Validates that the seat really is reclaimable,
 * drafts the reason, and stores a license_reclaims row status='proposed'. Idempotent: if a
 * proposal is already open for the seat it is returned unchanged. Never sends or cancels
 * anything - a human approves next.
 */
export function proposeReclaim(seatId: number): { id: number; status: string; reason: string; savings_monthly: number } {
  const db = getDb();
  const rec = reconcile();
  const target = rec.reclaimable.find((r) => r.seat_id === seatId);
  if (!target) throw new Error(`seat ${seatId} is not reclaimable (assignee is on the active roster)`);

  const existing = db
    .prepare(
      `SELECT id, reason, savings_monthly, status FROM license_reclaims
       WHERE seat_id = ? AND status IN ('proposed','approved','reclaimed') ORDER BY id DESC LIMIT 1`
    )
    .get(seatId) as { id: number; reason: string; savings_monthly: number; status: string } | undefined;
  if (existing)
    return {
      id: existing.id,
      status: existing.status,
      reason: existing.reason,
      savings_monthly: existing.savings_monthly,
    };

  const annual = target.cost_monthly * 12;
  const when =
    target.reason_kind === 'terminated'
      ? `terminated ${target.terminated_at || 'date unknown'}`
      : 'no longer on the active roster';
  const reason = `${target.vendor_label} ${target.product || 'seat'} assigned to ${target.assignee_name}, ${when}. Reclaim to save ${money(annual)}/yr (${money(target.cost_monthly)}/mo). Drafts a deprovision/offboard task for approval; nothing cancels automatically.`;

  const info = db
    .prepare(
      `INSERT INTO license_reclaims (seat_id, status, reason, savings_monthly) VALUES (?, 'proposed', ?, ?)`
    )
    .run(seatId, reason, target.cost_monthly);
  return { id: Number(info.lastInsertRowid), status: 'proposed', reason, savings_monthly: target.cost_monthly };
}

/** The human gate: approve a proposed reclaim (authorizes the offboard task). Logs the approval. */
export function approveReclaim(id: number): { ok: boolean; status: string } {
  const db = getDb();
  const row = db.prepare(`SELECT id, status FROM license_reclaims WHERE id = ?`).get(id) as
    | { id: number; status: string }
    | undefined;
  if (!row) throw new Error(`reclaim ${id} not found`);
  if (row.status === 'proposed') {
    db.prepare(`UPDATE license_reclaims SET status = 'approved', approved_at = datetime('now') WHERE id = ?`).run(id);
  }
  return { ok: true, status: 'approved' };
}

/** The full reclaim queue (proposals + approvals) for the activity panel. */
export function getReclaimQueue(): {
  id: number;
  seat_id: number;
  status: string;
  reason: string;
  savings_monthly: number;
  proposed_at: string;
  approved_at: string | null;
  vendor: string | null;
  vendor_label: string;
  assignee_name: string | null;
}[] {
  const rows = getDb()
    .prepare(
      `SELECT r.*, s.vendor AS vendor, s.assignee_name AS assignee_name
       FROM license_reclaims r LEFT JOIN license_seats s ON s.id = r.seat_id
       WHERE r.status IN ('proposed','approved','reclaimed')
       ORDER BY r.id DESC`
    )
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    seat_id: r.seat_id,
    status: r.status,
    reason: r.reason,
    savings_monthly: r.savings_monthly,
    proposed_at: r.proposed_at,
    approved_at: r.approved_at,
    vendor: r.vendor,
    vendor_label: vendorLabel(r.vendor || ''),
    assignee_name: r.assignee_name,
  }));
}
