import { Router } from 'express';
import { getDb } from '../db/index';
import { syncDeficiencies, CLOSED_STATUSES, AVG_REPAIR_USD } from '../services/deficiencySync';
import { currentContext, resolveOffice, officeScopeClause } from '../os/scope';
import { officeLabel } from '../os/office';

/**
 * Repair backlog: the open ServiceTrade deficiencies (repairs techs already found) as quotable
 * work, office-scoped. GET serves the backlog summary + the highest-value open items. Sync pulls
 * the mirror. Drafting a repair quote is gated and never writes to ServiceTrade (live:false).
 *
 * Office scope is enforced server-side via the OS scope layer (os_office_key), so a scoped caller
 * only ever sees their office's deficiencies. Deficiencies carry no price, so the value is a
 * PROJECTION: open count x an assumed average repair ticket (always labeled projected).
 */
const router = Router();
const ST_APP = 'https://app.servicetrade.com';
const OPEN_CLAUSE = `lower(status) NOT IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(',')})`;

interface DefRow {
  id: number;
  st_id: number | null;
  job_st_id: number | null;
  company_name: string | null;
  location_name: string | null;
  description: string | null;
  status: string | null;
  severity: string | null;
  proposed_usd: number;
  quoted?: number;
  office: string | null;
  reported_at?: string | null;
  disposition?: string | null;
  disposition_note?: string | null;
}

router.get('/api/deficiencies', (req, res) => {
  const db = getDb();
  const ctx = currentContext(req);
  const resolved = resolveOffice(ctx, req.query.office as string);
  if ('error' in resolved) return res.status(resolved.status).json({ ok: false, error: resolved.error });
  const scope = officeScopeClause('office', ctx, resolved.office);
  const oc = ` AND ${scope.sql}`;
  const bind = scope.params;
  const scalar = (sql: string): number => {
    try {
      return (db.prepare(sql).get(...bind) as { v: number }).v || 0;
    } catch {
      return 0;
    }
  };

  const openCount = scalar(`SELECT COUNT(*) AS v FROM deficiencies WHERE ${OPEN_CLAUSE}${oc}`);
  const quotedCount = scalar(`SELECT COUNT(*) AS v FROM deficiencies WHERE ${OPEN_CLAUSE} AND quoted = 1${oc}`);
  const quotedUsd = scalar(`SELECT COALESCE(SUM(proposed_usd),0) AS v FROM deficiencies WHERE ${OPEN_CLAUSE}${oc}`); // real, from linked quotes
  const unquotedCount = openCount - quotedCount;
  const projectedUsd = unquotedCount * AVG_REPAIR_USD;
  const totalUsd = quotedUsd + projectedUsd;
  const total = scalar(`SELECT COUNT(*) AS v FROM deficiencies WHERE 1=1${oc}`);

  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(proposed_usd),0) AS usd FROM deficiencies WHERE ${OPEN_CLAUSE}${oc} GROUP BY status ORDER BY n DESC`)
    .all(...bind) as { status: string; n: number; usd: number }[];

  // Age buckets over the whole OPEN backlog (accurate, not just the top-150 list).
  const ageBuckets = (() => {
    try {
      const r = db.prepare(
        `SELECT
           SUM(CASE WHEN reported_at IS NULL OR julianday('now')-julianday(reported_at)<=30 THEN 1 ELSE 0 END) b0,
           SUM(CASE WHEN julianday('now')-julianday(reported_at)>30 AND julianday('now')-julianday(reported_at)<=60 THEN 1 ELSE 0 END) b30,
           SUM(CASE WHEN julianday('now')-julianday(reported_at)>60 AND julianday('now')-julianday(reported_at)<=90 THEN 1 ELSE 0 END) b60,
           SUM(CASE WHEN julianday('now')-julianday(reported_at)>90 THEN 1 ELSE 0 END) b90
         FROM deficiencies WHERE ${OPEN_CLAUSE}${oc}`
      ).get(...bind) as any;
      return [{ key: '0-30', label: '0-30d', n: r.b0 || 0 }, { key: '31-60', label: '31-60d', n: r.b30 || 0 }, { key: '61-90', label: '61-90d', n: r.b60 || 0 }, { key: '90plus', label: '90+d', n: r.b90 || 0 }];
    } catch { return []; }
  })();

  const rows = db
    .prepare(
      `SELECT id, st_id, job_st_id, company_name, location_name, description, status, severity, proposed_usd, quoted, office,
              reported_at, disposition, disposition_note
         FROM deficiencies WHERE ${OPEN_CLAUSE}${oc}
        ORDER BY proposed_usd DESC, id DESC LIMIT 150`
    )
    .all(...bind) as DefRow[];

  const officeName = resolved.office === 'all' || resolved.office === '__scoped__' ? 'all' : officeLabel(resolved.office);
  res.json({
    office: officeName,
    live: total > 0,
    summary: {
      openCount,
      quotedCount,
      quotedUsd: Math.round(quotedUsd), // REAL dollars from linked repair quotes
      unquotedCount,
      projectedUsd, // un-quoted, at the assumed ticket
      totalUsd: Math.round(totalUsd),
      avgTicket: AVG_REPAIR_USD,
    },
    ageBuckets,
    byStatus,
    items: rows.map((r) => ({
      ...r,
      // ServiceTrade has no standalone deficiency page (that path 404s); a deficiency is viewed on
      // its job. Link to the parent job, which is a real, working ServiceTrade URL.
      stUrl: r.job_st_id ? `${ST_APP}/jobs/${r.job_st_id}` : null,
    })),
  });
});

/** Set a disposition on why an open deficiency isn't being converted. Office scope-checked. */
const VALID_DISPOSITIONS = ['needs_review', 'customer_declined', 'duplicate', 'warranty', 'waiting_information', 'quote_in_progress'];
router.post('/api/deficiencies/:id/disposition', (req, res) => {
  const ctx = currentContext(req);
  const db = getDb();
  const row = db.prepare(`SELECT id, office FROM deficiencies WHERE id = ?`).get(Number(req.params.id)) as { id: number; office: string | null } | undefined;
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  if (row.office && !ctx.allOffices && !ctx.offices.includes(row.office)) return res.status(403).json({ ok: false, error: 'office_forbidden' });
  const disp = String(req.body?.disposition || '');
  if (disp && !VALID_DISPOSITIONS.includes(disp)) return res.status(400).json({ ok: false, error: 'bad_disposition' });
  db.prepare(`UPDATE deficiencies SET disposition = ?, disposition_note = ?, disposition_by = ?, disposition_at = datetime('now') WHERE id = ?`)
    .run(disp || null, req.body?.note || null, ctx.email || 'system', row.id);
  res.json({ ok: true });
});

/** Pull the deficiency backlog from ServiceTrade into the mirror (read-only). */
router.post('/api/deficiencies/sync', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await syncDeficiencies()) });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Draft a repair quote for one deficiency (gated, demo). Never writes to ServiceTrade. */
router.post('/api/deficiencies/:id/quote', (req, res) => {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM deficiencies WHERE id = ?`).get(Number(req.params.id)) as DefRow | undefined;
  if (!row) return res.status(404).json({ ok: false, error: 'deficiency not found' });
  const value = row.proposed_usd > 0 ? `$${Math.round(row.proposed_usd).toLocaleString('en-US')}` : 'to be priced';
  const draft =
    `Repair quote for ${row.company_name || 'the account'}` +
    (row.location_name ? ` (${row.location_name})` : '') +
    `:\n${row.description || 'Deficiency correction'}\nEstimated: ${value}\n\n` +
    `This corrects a deficiency our technician already documented on site. Approving it closes the open ` +
    `finding and keeps the system inspection-ready.`;
  res.json({ ok: true, draft, live: false });
});

export default router;
