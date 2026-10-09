/**
 * Phones & iPads API (the Devices screen under IT). Reads need a People role; imports, edits and syncs
 * are IT / People admin only and are written to the audit trail. Never accepts or returns a password.
 */
import { Router } from 'express';
import { requirePeople } from '../people/authz';
import { getDb } from '../db/index';
import { osAudit } from '../os/audit';
import * as fleet from '../services/mobileFleet';
import { syncTeamsVoice, teamsVoiceStatus, teamsPermissionGaps } from '../services/teamsVoice';
import { graphUsersConfigured } from '../services/msGraphUsers';
import { syncAddigy, syncAbm, addigyConfigured, abmConfigured } from '../services/appleDevices';

const router = Router();
const actor = (req: any): string => (req.user?.email as string) || 'system';
const IT = requirePeople('people_admin', 'it');
const fail = (res: any, err: unknown, code = 400) => res.status(code).json({ ok: false, error: (err as Error).message });

router.get('/api/devices', requirePeople(), (_req, res) => {
  const { lines, summary } = fleet.listLines();
  const employees = getDb().prepare(`SELECT id, COALESCE(entra_display_name, COALESCE(preferred_name, legal_first_name) || ' ' || legal_last_name) AS name, office, employment_status AS status
    FROM employees WHERE employment_status != 'terminated' ORDER BY name`).all();
  res.json({
    ok: true, summary, lines, plans: fleet.planList(), employees,
    sources: {
      teams: { connected: graphUsersConfigured(), last: teamsVoiceStatus() },
      addigy: { connected: addigyConfigured(), syncedAt: summary.addigySyncedAt },
      abm: { connected: abmConfigured(), syncedAt: summary.abmSyncedAt },
      att: { reportAt: summary.attReportAt },
    },
  });
});

router.get('/api/devices/lines/:id', requirePeople(), (req, res) => {
  const d = fleet.lineDetail(Number(req.params.id));
  if (!d) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, line: d });
});
router.post('/api/devices/lines/:id', IT, (req, res) => {
  try { res.json({ ok: true, line: fleet.updateLine(Number(req.params.id), req.body || {}, actor(req)) }); } catch (err) { fail(res, err); }
});
router.post('/api/devices/lines/:id/events', IT, (req, res) => {
  try { res.json({ ok: true, line: fleet.addLineEvent(Number(req.params.id), req.body || {}, actor(req)) }); } catch (err) { fail(res, err); }
});

router.post('/api/devices/import/att-report', IT, (req, res) => {
  const csv = String((req.body || {}).csv || '');
  if (!csv.trim()) return res.status(400).json({ ok: false, error: 'no file provided' });
  try {
    const out = fleet.importAttReport(csv, actor(req), !!req.body.commit);
    if (out.committed) osAudit({ actor: actor(req), actor_email: actor(req), module: 'access', action: 'devices.att_import', detail: `${out.total} lines, ${out.created} new` });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { fail(res, err, 500); }
});
router.post('/api/devices/import/workbook', IT, (req, res) => {
  const sheets = Array.isArray((req.body || {}).sheets) ? req.body.sheets : [];
  if (!sheets.length) return res.status(400).json({ ok: false, error: 'no sheets provided' });
  try {
    const out = fleet.importWorkbook(sheets, actor(req), !!req.body.commit);
    if (out.committed) osAudit({ actor: actor(req), actor_email: actor(req), module: 'access', action: 'devices.workbook_import', detail: `${out.total} lines, ${out.matched} matched` });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { fail(res, err, 500); }
});

router.post('/api/devices/plan-costs', IT, (req, res) => {
  try { fleet.setPlanCost(req.body?.plan, req.body?.monthly_cost); res.json({ ok: true, plans: fleet.planList() }); } catch (err) { fail(res, err); }
});
router.post('/api/devices/bill-total', IT, (req, res) => {
  try { fleet.setBillTotal(req.body?.amount); res.json({ ok: true, billTotal: fleet.billTotal() }); } catch (err) { fail(res, err); }
});

router.get('/api/devices/teams-audit', requirePeople(), async (_req, res) => {
  const audit = fleet.teamsAudit();
  res.json({ ok: true, ...audit, status: teamsVoiceStatus(), permissionGaps: await teamsPermissionGaps().catch(() => null) });
});

router.post('/api/devices/sync/:source', IT, async (req, res) => {
  const src = req.params.source;
  try {
    if (src === 'teams') { const s = await syncTeamsVoice(Number(req.body?.days) || 90); return res.json({ ok: s.ok, error: s.error, status: s }); }
    if (src === 'addigy') { const r = await syncAddigy(); return res.json({ ok: r.ok, error: r.ok ? undefined : r.message, message: r.message }); }
    if (src === 'abm') { const r = await syncAbm(); return res.json({ ok: r.ok, error: r.ok ? undefined : r.message, message: r.message }); }
    res.status(404).json({ ok: false, error: 'unknown source' });
  } catch (err) { fail(res, err, 500); }
});

router.get('/api/devices/export.csv', requirePeople(), (_req, res) => {
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="phones-and-ipads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + fleet.linesCsv());
});

export default router;
