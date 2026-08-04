import { getDb } from '../db/index';
import { VENDORS } from './licenseAgent';
import type { Vendor } from './licenseSources';

/**
 * Universal seat import (CSV / admin-export → license_seats, source='manual').
 *
 * This is the backbone that makes every vendor usable today — including Bluebeam, HydraCAD and
 * HFSS, which have no public API at all. An admin exports the seat roster from each vendor's
 * console and pastes/uploads the CSV; we parse it and REPLACE that vendor's manual inventory
 * (idempotent — re-importing the same file is a no-op, not a duplicate). Seed and API-pulled
 * rows are left untouched; only source='manual' rows for that vendor are swapped.
 */

export interface ImportRow {
  assignee_email: string | null;
  assignee_name: string | null;
  product: string | null;
  cost_monthly: number;
  assigned_at: string | null;
}

/** A sensible default monthly seat price per vendor when the CSV omits a cost column. */
const DEFAULT_COST: Record<Vendor, number> = {
  microsoft: 36, // M365 E3 list
  adobe: 90, // Creative Cloud All Apps
  autocad: 235, // AutoCAD subscription
  bluebeam: 30, // Revu subscription
  hydracad: 145, // HydraCAD (Hydratec)
  hfss: 20, // HFSS
};

export function isVendor(v: string): v is Vendor {
  return VENDORS.some((x) => x.key === v);
}

/** Split one CSV line, honoring double-quoted fields (with "" escapes). Good enough for exports. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const EMAIL_KEYS = ['email', 'assignee_email', 'user', 'userprincipalname', 'upn', 'login', 'work_email', 'workemail'];
const NAME_KEYS = ['name', 'assignee_name', 'full_name', 'fullname', 'displayname', 'display_name', 'user_name'];
const PRODUCT_KEYS = ['product', 'plan', 'sku', 'license', 'profile', 'product_name'];
const COST_KEYS = ['cost_monthly', 'monthly_cost', 'cost', 'price', 'monthly', 'seat_cost', 'amount'];
const DATE_KEYS = ['assigned_at', 'assigned', 'start', 'start_date', 'since', 'hire_date', 'granted'];

const pick = (row: Record<string, string>, keys: string[]): string | null => {
  for (const k of keys) if (row[k] != null && row[k] !== '') return row[k];
  return null;
};

/**
 * Parse a CSV string into import rows. The header row is matched flexibly (case/space
 * insensitive) against common column names, so a raw admin export usually just works.
 */
export function parseCsv(csv: string, vendor: Vendor, defaultProduct: string): ImportRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => (rec[h] = cells[idx] != null ? cells[idx] : ''));
    const email = pick(rec, EMAIL_KEYS);
    const costRaw = pick(rec, COST_KEYS);
    const cost = costRaw != null ? parseFloat(costRaw.replace(/[$,\s]/g, '')) : NaN;
    // skip a fully empty line (no email AND no name)
    const name = pick(rec, NAME_KEYS);
    if (!email && !name) continue;
    rows.push({
      assignee_email: email ? email.toLowerCase() : null,
      assignee_name: name || email || null,
      product: pick(rec, PRODUCT_KEYS) || defaultProduct,
      cost_monthly: isFinite(cost) ? cost : DEFAULT_COST[vendor],
      assigned_at: pick(rec, DATE_KEYS),
    });
  }
  return rows;
}

/**
 * Replace the manual seat inventory for one vendor with the given rows (idempotent).
 * Returns how many seats were imported. Seed and API-pulled seats are never touched.
 */
export function importManualSeats(vendor: Vendor, rows: ImportRow[], product: string): { imported: number } {
  const db = getDb();
  const tx = db.transaction((rs: ImportRow[]) => {
    // Real data supersedes the demo seed for this vendor (and replaces any prior manual import).
    db.prepare(`DELETE FROM license_seats WHERE vendor = ? AND source IN ('seed','manual')`).run(vendor);
    const ins = db.prepare(
      `INSERT INTO license_seats (vendor, product, assignee_email, assignee_name, cost_monthly, assigned_at, source)
       VALUES (?, ?, ?, ?, ?, ?, 'manual')`
    );
    for (const r of rs) {
      ins.run(vendor, r.product || product, r.assignee_email, r.assignee_name, r.cost_monthly, r.assigned_at);
    }
  });
  tx(rows);
  return { imported: rows.length };
}
