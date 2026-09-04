import { Router } from 'express';
import { currentContext } from '../os/scope';
import { officeBranding } from '../services/officeBranding';
import { inspectionSystems, templateFor, checklistFor } from '../services/nfpaChecklists';
import { searchAccounts } from '../services/quotesBuilder';
import {
  createInspection, listInspections, getInspection, updateInspection,
  setItemResult, finalizeInspection, deleteInspection,
} from '../services/inspections';

/**
 * Phase 5 API: NFPA ITM inspections and AHJ reports. Systems + checklists come from the NFPA reference
 * data; an inspection snapshots one, the inspector scores each line, and finalize pushes failures into
 * the deficiencies backlog. The detail response carries the office branding so the client can render a
 * letterheaded AHJ inspection report.
 */
const router = Router();
const O = (req: any): string => String(req.query.office || req.body?.office || '');
const who = (req: any): string | undefined => { const c = currentContext(req); return c.user?.display_name || c.user?.email || undefined; };

/* ---- reference data ---- */
router.get('/api/inspections/systems', (_req, res) => res.json({ ok: true, systems: inspectionSystems() }));
router.get('/api/inspections/checklist', (req, res) => {
  const tpl = templateFor(String(req.query.system || ''));
  if (!tpl) return res.status(404).json({ ok: false, error: 'unknown system' });
  res.json({ ok: true, code: tpl.code, standard: tpl.standard, intervals: tpl.intervals, cycles: tpl.cycles || [], items: checklistFor(tpl.system, String(req.query.interval || '')) });
});

/* ---- account link (reuse the CRM search) ---- */
router.get('/api/inspections/accounts', (req, res) => res.json({ ok: true, accounts: searchAccounts(String(req.query.q || '')) }));

/* ---- inspections ---- */
router.get('/api/inspections', (req, res) => res.json({ ok: true, inspections: listInspections(O(req), String(req.query.status || '')) }));

router.post('/api/inspections', (req, res) => {
  const out = createInspection({ ...(req.body || {}), office: O(req), created_by: who(req) });
  res.status(out ? 200 : 400).json(out ? { ok: true, ...out } : { ok: false, error: 'unknown system' });
});

router.get('/api/inspections/:id(\\d+)', (req, res) => {
  const out = getInspection(Number(req.params.id));
  if (!out) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, ...out, branding: officeBranding(out.inspection.office) });
});

router.put('/api/inspections/:id(\\d+)', (req, res) => {
  const out = updateInspection(Number(req.params.id), req.body || {});
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});

router.post('/api/inspections/:id(\\d+)/item/:itemId(\\d+)', (req, res) => {
  const b = req.body || {};
  const out = setItemResult(Number(req.params.itemId), String(b.result || ''), b.note !== undefined ? String(b.note) : undefined);
  res.status(out ? 200 : 404).json(out ? { ok: true, item: out } : { ok: false, error: 'not found' });
});

router.post('/api/inspections/:id(\\d+)/finalize', (req, res) => {
  const out = finalizeInspection(Number(req.params.id), who(req));
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out, branding: officeBranding(out.inspection.office) } : { ok: false, error: 'not found' });
});

router.delete('/api/inspections/:id(\\d+)', (req, res) => res.json({ ok: deleteInspection(Number(req.params.id)) }));

export default router;
