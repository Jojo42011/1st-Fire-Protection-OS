import { Router } from 'express';
import { getDb } from '../db/index';
import { syncDeficiencies, CLOSED_STATUSES } from '../services/deficiencySync';

/**
 * Repair backlog: the open ServiceTrade deficiencies (repairs techs already found) as quotable
 * work, office-scoped. GET serves the backlog summary + the highest-value open items. Sync pulls
 * the mirror. Drafting a repair quote is gated and never writes to ServiceTrade (live:false).
 */
const router = Router();
const ST_APP = 'https://app.servicetrade.com';
const OPEN_CLAUSE = `lower(status) NOT IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(',')})`;

interface DefRow {
  id: number;
  st_id: number | null;
  company_name: string | null;
  location_name: string | null;
  description: string | null;
  status: string | null;
  severity: string | null;
  proposed_usd: number;
  office: string | null;
}

router.get('/api/deficiencies', (req, res) => {
  const db = getDb();
  const office = String(req.query.office || '').trim();
  const oc = office && office !== 'all' ? ` AND office = @office` : '';
  const bind = office && office !== 'all' ? [{ office }] : [];
  const scalar = (sql: string): number => {
    try {
      return (db.prepare(sql).get(...bind) as { v: number }).v || 0;
    } catch {
      return 0;
    }
  };

  const openCount = scalar(`SELECT COUNT(*) AS v FROM deficiencies WHERE ${OPEN_CLAUSE}${oc}`);
  const backlogUsd = scalar(`SELECT COALESCE(SUM(proposed_usd),0) AS v FROM deficiencies WHERE ${OPEN_CLAUSE}${oc}`);
  const valued = scalar(`SELECT COUNT(*) AS v FROM deficiencies WHERE ${OPEN_CLAUSE} AND proposed_usd > 0${oc}`);
  const total = scalar(`SELECT COUNT(*) AS v FROM deficiencies${office && office !== 'all' ? ' WHERE office = @office' : ''}`);

  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(proposed_usd),0) AS usd FROM deficiencies WHERE ${OPEN_CLAUSE}${oc} GROUP BY status ORDER BY n DESC`)
    .all(...bind) as { status: string; n: number; usd: number }[];

  const rows = db
    .prepare(
      `SELECT id, st_id, company_name, location_name, description, status, severity, proposed_usd, office
         FROM deficiencies WHERE ${OPEN_CLAUSE}${oc}
        ORDER BY proposed_usd DESC, id DESC LIMIT 150`
    )
    .all(...bind) as DefRow[];

  res.json({
    office: office || 'all',
    live: total > 0,
    summary: { openCount, backlogUsd: Math.round(backlogUsd), valued, avgUsd: valued ? Math.round(backlogUsd / valued) : 0 },
    byStatus,
    items: rows.map((r) => ({
      ...r,
      stUrl: r.st_id ? `${ST_APP}/deficiencies/${r.st_id}` : null,
    })),
  });
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
