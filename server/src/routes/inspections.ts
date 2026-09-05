import { Router } from 'express';
import { requireOs, actorOf, officeKeysOrFail, writeOfficeOrFail, canActOnOffice } from '../os/authz';
import { P } from '../os/policy';
import { osAudit } from '../os/audit';
import { officeBranding } from '../services/officeBranding';
import { inspectionSystems, templateFor, checklistFor } from '../services/nfpaChecklists';
import { searchAccounts } from '../services/quotesBuilder';
import {
  createInspection, listInspections, getInspection, updateInspection,
  setItemResult, finalizeInspection, deleteInspection,
} from '../services/inspections';

/**
 * Phase 5 API: NFPA ITM inspections and AHJ reports. Authorized + office-scoped like the rest of the
 * estimating family. Reference data (systems/checklists) is non-sensitive; inspection records are
 * scoped by office and inspection IDs are checked against the caller's scope.
 */
const router = Router();

/** Verify an inspection is in the caller's office scope; sends 404/403 and returns null on failure. */
function scopeInspection(req: any, res: any, id: number) {
  const d = getInspection(id);
  if (!d) { res.status(404).json({ ok: false, error: 'not found' }); return null; }
  if (!canActOnOffice(req, d.inspection.office)) { res.status(403).json({ ok: false, error: 'office_forbidden' }); return null; }
  return d;
}

/* ---- reference data (non-sensitive) ---- */
router.get('/api/inspections/systems', requireOs(P.inspections_read), (_req, res) => res.json({ ok: true, systems: inspectionSystems() }));
router.get('/api/inspections/checklist', requireOs(P.inspections_read), (req, res) => {
  const tpl = templateFor(String(req.query.system || ''));
  if (!tpl) return res.status(404).json({ ok: false, error: 'unknown system' });
  res.json({ ok: true, code: tpl.code, standard: tpl.standard, intervals: tpl.intervals, cycles: tpl.cycles || [], items: checklistFor(tpl.system, String(req.query.interval || '')) });
});

/* ---- account link (scoped) ---- */
router.get('/api/inspections/accounts', requireOs(P.inspections_read), (req, res) => {
  const scope = officeKeysOrFail(req, res); if (scope === null) return;
  res.json({ ok: true, accounts: searchAccounts(String(req.query.q || ''), scope === 'ALL' ? null : scope) });
});

/* ---- inspections ---- */
router.get('/api/inspections', requireOs(P.inspections_read), (req, res) => {
  const scope = officeKeysOrFail(req, res); if (scope === null) return;
  res.json({ ok: true, inspections: listInspections(scope === 'ALL' ? null : scope, String(req.query.status || '')) });
});

router.post('/api/inspections', requireOs(P.inspections_write), (req, res) => {
  const office = writeOfficeOrFail(req, res); if (office === null) return;
  const who = actorOf(req);
  const out = createInspection({ ...(req.body || {}), office, created_by: who.label });
  if (out) osAudit({ actor: who.label, actor_email: who.email, office, module: 'service', action: 'inspection.create', subject_type: 'inspection', subject_id: out.inspection.id, new_summary: `${out.inspection.code} ${out.inspection.number}` });
  res.status(out ? 200 : 400).json(out ? { ok: true, ...out } : { ok: false, error: 'unknown system' });
});

router.get('/api/inspections/:id(\\d+)', requireOs(P.inspections_read), (req, res) => {
  const d = scopeInspection(req, res, Number(req.params.id)); if (!d) return;
  res.json({ ok: true, ...d, branding: officeBranding(d.inspection.office) });
});

router.put('/api/inspections/:id(\\d+)', requireOs(P.inspections_write), (req, res) => {
  const id = Number(req.params.id);
  if (!scopeInspection(req, res, id)) return;
  const out = updateInspection(id, req.body || {});
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});

router.post('/api/inspections/:id(\\d+)/item/:itemId(\\d+)', requireOs(P.inspections_write), (req, res) => {
  const id = Number(req.params.id);
  if (!scopeInspection(req, res, id)) return;
  const b = req.body || {};
  const out = setItemResult(Number(req.params.itemId), String(b.result || ''), b.note !== undefined ? String(b.note) : undefined);
  res.status(out ? 200 : 404).json(out ? { ok: true, item: out } : { ok: false, error: 'not found' });
});

router.post('/api/inspections/:id(\\d+)/finalize', requireOs(P.inspections_write), (req, res) => {
  const id = Number(req.params.id);
  const d = scopeInspection(req, res, id); if (!d) return;
  const who = actorOf(req);
  const out = finalizeInspection(id, who.label);
  if (out) osAudit({ actor: who.label, actor_email: who.email, office: out.inspection.office, module: 'service', action: 'inspection.finalize', subject_type: 'inspection', subject_id: id, new_summary: `${out.inspection.result}, ${out.deficiencies_created} findings` });
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out, branding: officeBranding(out.inspection.office) } : { ok: false, error: 'not found' });
});

router.delete('/api/inspections/:id(\\d+)', requireOs(P.inspections_write), (req, res) => {
  const id = Number(req.params.id);
  if (!scopeInspection(req, res, id)) return;
  res.json({ ok: deleteInspection(id) });
});

export default router;
