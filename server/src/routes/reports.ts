import { Router } from 'express';
import { getDb } from '../db/index';
import { currentContext, allowedOffices, OsContext } from '../os/scope';
import { runMetric, metricByOffice, metricCatalog, metricKeys, metricCard, metricTrend, metricDrill } from '../os/metrics';
import { resolvePeriod, PERIODS } from '../os/period';
import { officeLabel } from '../os/office';
import { nextWeeklyRun, renderReport } from '../services/reportScheduler';
import { mailConfigured, sendMail } from '../services/msGraphMail';

/**
 * Reporting API (Phase 2). Everything is office- and date-scoped and enforced server-side:
 *   GET  /api/reports/catalog          - metrics, periods, and the caller's authorized offices
 *   GET  /api/metrics/:key             - one metric for a scope (office + period)
 *   GET  /api/metrics/:key/by-office   - the metric per authorized office (for comparison)
 *   GET  /api/reports/office           - an office dashboard bundle (KPIs + comparison + funnel)
 *   GET/POST/PUT/DELETE /api/reports/saved[/:id]  - saved report definitions
 *   POST /api/reports/saved/:id/run    - run a saved report UNDER THE VIEWING USER'S scope
 *
 * A saved report stores a definition, never a snapshot: when run, its office is re-resolved against
 * the current viewer's authorization, so sharing/opening a report never widens access.
 */
const router = Router();

function rangeFrom(req: any) {
  return resolvePeriod(req.query.period as string, { start: req.query.start as string, end: req.query.end as string });
}
function ownerKey(ctx: OsContext): string {
  return ctx.email || '(shared)'; // legacy shared-password sessions share one bucket (same principal)
}

router.get('/api/reports/catalog', (req, res) => {
  const ctx = currentContext(req);
  res.json({ ok: true, metrics: metricCatalog(), periods: PERIODS, offices: allowedOffices(ctx), canSeeAllOffices: ctx.allOffices });
});

router.get('/api/metrics/:key', (req, res) => {
  const ctx = currentContext(req);
  // The canonical KPI card contract: value + format + tone + comparison (pass ?compare=1).
  const r = metricCard(req.params.key, ctx, { office: req.query.office as string, range: rangeFrom(req), compare: req.query.compare === '1' });
  if ('error' in r) return res.status(r.status).json({ ok: false, error: r.error });
  res.json({ ok: true, metric: r });
});

/** Real time series for a date-scoped metric (unsupported for point-in-time metrics - no fabrication). */
router.get('/api/metrics/:key/trend', (req, res) => {
  const ctx = currentContext(req);
  const t = metricTrend(req.params.key, ctx, { office: req.query.office as string, range: rangeFrom(req) });
  res.json({ ok: true, ...t });
});

/** The authorized records behind a metric (same scope/definition), paginated + sorted. */
router.get('/api/drilldown/:key', (req, res) => {
  const ctx = currentContext(req);
  const r = metricDrill(req.params.key, ctx, {
    office: req.query.office as string,
    range: rangeFrom(req),
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    offset: req.query.offset ? Number(req.query.offset) : undefined,
  });
  if ('error' in r) return res.status(r.status).json({ ok: false, error: r.error });
  res.json({ ok: true, ...r });
});

router.get('/api/metrics/:key/by-office', (req, res) => {
  const ctx = currentContext(req);
  if (!metricKeys().includes(req.params.key)) return res.status(404).json({ ok: false, error: 'unknown_metric' });
  const rows = metricByOffice(req.params.key, ctx, { range: rangeFrom(req) });
  res.json({ ok: true, metric: req.params.key, rows });
});

/** The office dashboard bundle: the KPIs and comparisons a partner/branch manager needs first. */
router.get('/api/reports/office', (req, res) => {
  const ctx = currentContext(req);
  const range = rangeFrom(req);
  const office = (req.query.office as string) || 'all';

  const kpiKeys = ['open_pipeline', 'quote_win_rate', 'repair_opportunity_total', 'open_deficiencies', 'jobs_completed', 'ar_90_plus'];
  const kpis: any[] = [];
  for (const k of kpiKeys) {
    const r = runMetric(k, ctx, { office, range });
    if ('error' in r) return res.status(r.status).json({ ok: false, error: r.error });
    kpis.push(r);
  }

  // Deficiency funnel - only the steps real data supports (found -> quoted -> quoted $).
  const open = runMetric('open_deficiencies', ctx, { office, range });
  const quoted = runMetric('quoted_deficiencies', ctx, { office, range });
  const quotedVal = runMetric('quoted_repair_value', ctx, { office, range });
  const funnel = ('error' in open || 'error' in quoted || 'error' in quotedVal) ? [] : [
    { step: 'Open deficiencies', value: open.value, unit: 'count' },
    { step: 'Quoted', value: quoted.value, unit: 'count' },
    { step: 'Quoted value', value: quotedVal.value, unit: 'usd' },
  ];

  // Office comparison (company-wide callers see all their offices ranked on open pipeline).
  const comparison = ctx.allOffices || allowedOffices(ctx).length > 1
    ? metricByOffice('open_pipeline', ctx, { range }).sort((a, b) => b.value - a.value)
    : [];

  const resolvedOffice = kpis[0]?.office || 'all';
  res.json({
    ok: true,
    office: resolvedOffice,
    officeName: resolvedOffice === 'all' || resolvedOffice === '__scoped__' ? 'All offices' : officeLabel(resolvedOffice),
    period: { key: range.key, label: range.label, start: range.start, end: range.end },
    kpis, funnel, comparison,
  });
});

/* ─────────────────────────── saved reports ─────────────────────────── */
router.get('/api/reports/saved', (req, res) => {
  const ctx = currentContext(req);
  const rows = getDb()
    .prepare(`SELECT id, name, config_json, updated_at, schedule, recipient, last_sent_at, next_run_at FROM saved_reports WHERE owner_email = ? ORDER BY name`)
    .all(ownerKey(ctx)) as any[];
  res.json({
    ok: true,
    mailConfigured: mailConfigured(),
    reports: rows.map((r) => ({
      id: r.id, name: r.name, config: safeJson(r.config_json), updated_at: r.updated_at,
      schedule: r.schedule || 'none', recipient: r.recipient || null, last_sent_at: r.last_sent_at || null, next_run_at: r.next_run_at || null,
    })),
  });
});

// Normalize the schedule fields from a request body. weekly requires a recipient email.
function scheduleFields(body: any): { schedule: string; recipient: string | null; next_run_at: string | null } {
  const schedule = body?.schedule === 'weekly' ? 'weekly' : 'none';
  const recipient = schedule === 'weekly' && body?.recipient ? String(body.recipient).trim() : null;
  const on = schedule === 'weekly' && recipient;
  return { schedule: on ? 'weekly' : 'none', recipient: on ? recipient : null, next_run_at: on ? nextWeeklyRun() : null };
}

router.post('/api/reports/saved', (req, res) => {
  const ctx = currentContext(req);
  const name = String(req.body?.name || '').trim();
  const config = req.body?.config;
  if (!name || !config || typeof config !== 'object') return res.status(400).json({ ok: false, error: 'name_and_config_required' });
  const s = scheduleFields(req.body);
  const info = getDb()
    .prepare(`INSERT INTO saved_reports (owner_email, name, config_json, schedule, recipient, next_run_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(ownerKey(ctx), name, JSON.stringify(config), s.schedule, s.recipient, s.next_run_at);
  res.json({ ok: true, id: Number(info.lastInsertRowid), schedule: s.schedule, recipient: s.recipient, mailConfigured: mailConfigured() });
});

router.put('/api/reports/saved/:id', (req, res) => {
  const ctx = currentContext(req);
  const row = ownedReport(ctx, req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  const name = req.body?.name != null ? String(req.body.name).trim() : row.name;
  const config = req.body?.config != null ? JSON.stringify(req.body.config) : row.config_json;
  const s = req.body?.schedule !== undefined ? scheduleFields(req.body) : { schedule: row.schedule || 'none', recipient: row.recipient || null, next_run_at: row.next_run_at || null };
  getDb()
    .prepare(`UPDATE saved_reports SET name = ?, config_json = ?, schedule = ?, recipient = ?, next_run_at = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name, config, s.schedule, s.recipient, s.next_run_at, row.id);
  res.json({ ok: true, schedule: s.schedule, recipient: s.recipient, mailConfigured: mailConfigured() });
});

/** Deliver a saved report to its recipient right now (owner only). Useful to confirm delivery. */
router.post('/api/reports/saved/:id/send-now', async (req, res) => {
  const ctx = currentContext(req);
  const row = ownedReport(ctx, req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  if (!row.recipient) return res.status(400).json({ ok: false, error: 'no_recipient' });
  if (!mailConfigured()) return res.status(409).json({ ok: false, error: 'mail_not_configured' });
  const rendered = renderReport(row.name, safeJson(row.config_json) || {}, row.owner_email);
  if ('error' in rendered) return res.status(400).json({ ok: false, error: rendered.error });
  const out = await sendMail(row.recipient, rendered.subject, rendered.html, '1st Fire Protection');
  if (!out.ok) return res.status(502).json({ ok: false, error: out.error });
  getDb().prepare(`UPDATE saved_reports SET last_sent_at = datetime('now') WHERE id = ?`).run(row.id);
  res.json({ ok: true, sent_to: row.recipient });
});

router.delete('/api/reports/saved/:id', (req, res) => {
  const ctx = currentContext(req);
  const row = ownedReport(ctx, req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  getDb().prepare(`DELETE FROM saved_reports WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

/** Run a saved report's stored definition against current data, UNDER THE VIEWING USER'S scope. */
router.post('/api/reports/saved/:id/run', (req, res) => {
  const ctx = currentContext(req);
  const row = ownedReport(ctx, req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  const cfg = safeJson(row.config_json) || {};
  const range = resolvePeriod(cfg.period, { start: cfg.start, end: cfg.end });
  const metricKey = cfg.metric || 'open_pipeline';

  if (cfg.groupBy === 'office') {
    const rows = metricByOffice(metricKey, ctx, { range });
    return res.json({ ok: true, name: row.name, config: cfg, groupBy: 'office', rows, period: { key: range.key, label: range.label } });
  }
  const r = runMetric(metricKey, ctx, { office: cfg.office, range });
  if ('error' in r) return res.status(r.status).json({ ok: false, error: r.error });
  res.json({ ok: true, name: row.name, config: cfg, metric: r, period: { key: range.key, label: range.label } });
});

function ownedReport(ctx: OsContext, id: string): any | null {
  const row = getDb().prepare(`SELECT * FROM saved_reports WHERE id = ?`).get(Number(id)) as any;
  if (!row || row.owner_email !== ownerKey(ctx)) return null; // only your own reports
  return row;
}
function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export default router;
