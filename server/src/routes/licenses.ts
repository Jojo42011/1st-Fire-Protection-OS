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
import { parseCsv, importManualSeats, isVendor } from '../services/licenseImport';
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
 * Universal seat import — CSV / admin-export → license_seats (source='manual'). Works for every
 * vendor with no credentials (the only path for Bluebeam/HydraCAD/HFSS). Body accepts either
 * raw `csv` text or a pre-parsed `seats` array, plus the target `vendor`. Idempotent per vendor:
 * re-importing replaces that vendor's manual inventory rather than duplicating it.
 */
router.post('/api/licenses/import', (req, res) => {
  try {
    const vendor = String(req.body?.vendor || '').toLowerCase();
    if (!isVendor(vendor)) return res.status(400).json({ ok: false, error: 'unknown vendor' });
    const product = VENDORS.find((v) => v.key === vendor)!.product;

    let rows;
    if (typeof req.body?.csv === 'string' && req.body.csv.trim()) {
      rows = parseCsv(req.body.csv, vendor, product);
    } else if (Array.isArray(req.body?.seats)) {
      rows = req.body.seats.map((s: any) => ({
        assignee_email: s.assignee_email ? String(s.assignee_email).toLowerCase() : s.email ? String(s.email).toLowerCase() : null,
        assignee_name: s.assignee_name || s.name || s.email || null,
        product: s.product || product,
        cost_monthly: Number(s.cost_monthly ?? s.cost ?? 0) || 0,
        assigned_at: s.assigned_at || null,
      }));
    } else {
      return res.status(400).json({ ok: false, error: 'provide csv text or a seats array' });
    }

    if (!rows.length) return res.status(400).json({ ok: false, error: 'no seats parsed — check the header row (needs an email or name column)' });
    const { imported } = importManualSeats(vendor, rows, product);
    res.json({ ok: true, vendor, imported, totals: reconcile().totals });
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
      // Clean rebuild of the BambooHR-sourced roster each sync, so a corrected pull fully
      // replaces any earlier rows (no stale statuses linger). Directory rows are active;
      // terminated rows overwrite by email. Seeded demo employees are left untouched.
      const rebuild = db.transaction(() => {
        db.prepare(`DELETE FROM hr_employees WHERE source = 'bamboo'`).run();
        for (const e of [...directory, ...terminated]) {
          if (!e.email) continue; // email is the reconciliation key
          upsert.run(e);
          employeesSynced += 1;
        }
      });
      rebuild();
    }
  } catch (err) {
    console.warn('[licenses] bamboo sync degraded:', (err as Error).message);
  }

  // ── seats from the vendor adapters (env-gated; unkeyed vendors are skipped) ──
  // Replace-by-vendor so a re-sync REFRESHES each keyed vendor's API seats instead of
  // duplicating them; seed and manually-imported (CSV) seats are always preserved.
  try {
    const seats = await fetchAllVendorSeats();
    if (seats.length) {
      const ins = db.prepare(
        `INSERT INTO license_seats (vendor, product, assignee_email, assignee_name, cost_monthly, assigned_at, source)
         VALUES (@vendor, @product, @assignee_email, @assignee_name, @cost_monthly, @assigned_at, @source)`
      );
      // Real API data supersedes the demo seed and any prior API pull for that vendor; a
      // manually-imported (CSV) roster for the same vendor is left in place.
      const del = db.prepare(`DELETE FROM license_seats WHERE vendor = ? AND source != 'manual'`);
      const byVendor = new Set(seats.map((s) => s.vendor));
      const tx = db.transaction(() => {
        for (const v of byVendor) del.run(v);
        for (const s of seats) { ins.run(s); seatsSynced += 1; }
      });
      tx();
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
