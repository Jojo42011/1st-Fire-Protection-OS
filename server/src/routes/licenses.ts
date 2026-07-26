import { Router } from 'express';
import { getDb } from '../db/index';
import {
  reconcile,
  getLicenseSummary,
  proposeReclaim,
  approveReclaim,
  getReclaimQueue,
  VENDORS,
} from '../services/licenseAgent';
import { fetchDirectory, fetchTerminated, bambooConfigured } from '../services/bamboo';
import { fetchAllVendorSeats, configuredVendors } from '../services/licenseSources';
import { createApproval } from './approvals';

const router = Router();

/** Dashboard data: summary + reclaimable list (grouped + flat) + all seats + savings totals. */
router.get('/api/licenses', (_req, res) => {
  const db = getDb();
  const rec = reconcile();
  const seats = db.prepare(`SELECT * FROM license_seats ORDER BY vendor, cost_monthly DESC`).all();
  res.json({
    summary: getLicenseSummary(),
    reclaimable: rec.reclaimable,
    byVendor: rec.byVendor,
    totals: rec.totals,
    seats,
    reclaims: getReclaimQueue(),
    vendors: VENDORS,
    bamboo: { connected: bambooConfigured() },
    liveVendors: configuredVendors(),
    live: bambooConfigured(),
  });
});

/** Flag a seat for reclaim (the DRAFT - human-gated, nothing cancels). */
router.post('/api/licenses/:seatId/flag', (req, res) => {
  try {
    const seatId = Number(req.params.seatId);
    const r = proposeReclaim(seatId);
    // Dual-write into the unified approvals inbox (best-effort).
    try {
      const seat = getDb()
        .prepare('SELECT assignee_name, product, vendor, cost_monthly FROM license_seats WHERE id = ?')
        .get(seatId) as { assignee_name: string | null; product: string | null; vendor: string; cost_monthly: number } | undefined;
      if (seat) {
        const yr = Math.round((seat.cost_monthly || 0) * 12).toLocaleString('en-US');
        const label = seat.product || seat.vendor;
        createApproval({
          agent_key: 'licenses',
          kind: 'cancel_seat',
          risk: 'sensitive',
          title: `Cancel the ${label} seat for ${seat.assignee_name || 'a former employee'}`,
          stake: `saves $${yr}/yr`,
          body: `The seat is still active and billing $${seat.cost_monthly}/mo. Offboarding task drafted for IT: revoke the license and reassign any shared work.`,
          trail: 'IT gets the task; nothing cancels until they run it',
          subject_type: 'seat',
          subject_id: seatId,
        });
      }
    } catch {
      /* inbox mirror is best-effort */
    }
    res.json({ ok: true, reclaim: r });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Approve a proposed reclaim (the human gate; authorizes the offboard/deprovision task). */
router.post('/api/licenses/reclaims/:id/approve', (req, res) => {
  try {
    const r = approveReclaim(Number(req.params.id));
    res.json({ ok: r.ok, status: r.status });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * Pull from BambooHR (+ the vendor adapters) and re-reconcile. Keyless-safe: with no keys the
 * adapters return null/[] and this is a graceful no-op that just re-runs the reconciliation on
 * the seeded data. Never throws.
 */
router.post('/api/licenses/sync', async (_req, res) => {
  const db = getDb();
  let employeesSynced = 0;
  let seatsSynced = 0;

  // ── roster from BambooHR (active directory + any terminated rows) ──
  try {
    const directory = await fetchDirectory();
    if (directory) {
      const terminated = await fetchTerminated();
      const upsert = db.prepare(
        `INSERT INTO hr_employees (full_name, email, department, title, status, hired_at, terminated_at, source)
         VALUES (@full_name, @email, @department, @title, @status, @hired_at, @terminated_at, 'bamboo')
         ON CONFLICT(email) DO UPDATE SET
           full_name=excluded.full_name, department=excluded.department, title=excluded.title,
           status=excluded.status, hired_at=excluded.hired_at, terminated_at=excluded.terminated_at,
           source='bamboo'`
      );
      for (const e of [...directory, ...terminated]) {
        if (!e.email) continue; // email is the reconciliation key
        upsert.run(e);
        employeesSynced += 1;
      }
    }
  } catch (err) {
    console.warn('[licenses] bamboo sync degraded:', (err as Error).message);
  }

  // ── seats from the vendor adapters (all stubbed until keyed; degrade to seed) ──
  try {
    const seats = await fetchAllVendorSeats();
    if (seats.length) {
      const ins = db.prepare(
        `INSERT INTO license_seats (vendor, product, assignee_email, assignee_name, cost_monthly, assigned_at, source)
         VALUES (@vendor, @product, @assignee_email, @assignee_name, @cost_monthly, @assigned_at, @source)`
      );
      for (const s of seats) {
        ins.run(s);
        seatsSynced += 1;
      }
    }
  } catch (err) {
    console.warn('[licenses] vendor seat sync degraded:', (err as Error).message);
  }

  res.json({
    ok: true,
    bamboo: bambooConfigured(),
    employeesSynced,
    seatsSynced,
    liveVendors: configuredVendors(),
    totals: reconcile().totals,
  });
});

export default router;
