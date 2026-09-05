import { Router } from 'express';
import { requireOs, actorOf, officeKeysOrFail, writeOfficeOrFail, canActOnOffice } from '../os/authz';
import { P } from '../os/policy';
import { osAudit } from '../os/audit';
import { board, listJobs, getJob, createJob, updateJob, setStage, deleteJob, jobForQuote, STAGES } from '../services/jobsBoard';

/**
 * Phase 4 API: the project board of jobs spawned from won quotes. Namespaced under /api/jobboard so it
 * never collides with the ServiceTrade job-readiness endpoint (crm.ts owns GET /api/jobs). Every route
 * is authorized and office-scoped; job IDs are checked against the caller's office scope.
 */
const router = Router();

/** Verify a job is in the caller's office scope; sends 404/403 and returns null on failure. */
function scopeJob(req: any, res: any, id: number) {
  const j = getJob(id);
  if (!j) { res.status(404).json({ ok: false, error: 'not found' }); return null; }
  if (!canActOnOffice(req, j.office)) { res.status(403).json({ ok: false, error: 'office_forbidden' }); return null; }
  return j;
}

router.get('/api/jobboard/stages', requireOs(P.jobs_read), (_req, res) => res.json({ ok: true, stages: STAGES }));

router.get('/api/jobboard/board', requireOs(P.jobs_read), (req, res) => {
  const scope = officeKeysOrFail(req, res); if (scope === null) return;
  res.json({ ok: true, ...board(scope === 'ALL' ? null : scope) });
});

router.get('/api/jobboard/list', requireOs(P.jobs_read), (req, res) => {
  const scope = officeKeysOrFail(req, res); if (scope === null) return;
  res.json({ ok: true, jobs: listJobs(scope === 'ALL' ? null : scope, String(req.query.stage || '')) });
});

router.post('/api/jobboard', requireOs(P.jobs_write), (req, res) => {
  const office = writeOfficeOrFail(req, res); if (office === null) return;
  const who = actorOf(req);
  const j = createJob({ ...(req.body || {}), office, created_by: who.label });
  osAudit({ actor: who.label, actor_email: who.email, office, module: 'service', action: 'job.create', subject_type: 'est_job', subject_id: j.id, new_summary: j.number || '' });
  res.json({ ok: true, job: j });
});

router.get('/api/jobboard/for-quote/:quoteId(\\d+)', requireOs(P.jobs_read), (req, res) => {
  const j = jobForQuote(Number(req.params.quoteId));
  if (j && !canActOnOffice(req, j.office)) return res.status(403).json({ ok: false, error: 'office_forbidden' });
  res.json({ ok: true, job: j });
});

router.get('/api/jobboard/:id(\\d+)', requireOs(P.jobs_read), (req, res) => {
  const j = scopeJob(req, res, Number(req.params.id)); if (!j) return;
  res.json({ ok: true, job: j });
});

router.put('/api/jobboard/:id(\\d+)', requireOs(P.jobs_write), (req, res) => {
  const id = Number(req.params.id);
  if (!scopeJob(req, res, id)) return;
  const j = updateJob(id, req.body || {});
  if (j) osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office: j.office, module: 'service', action: 'job.update', subject_type: 'est_job', subject_id: id });
  res.status(j ? 200 : 404).json(j ? { ok: true, job: j } : { ok: false, error: 'not found' });
});

router.post('/api/jobboard/:id(\\d+)/stage', requireOs(P.jobs_write), (req, res) => {
  const id = Number(req.params.id);
  if (!scopeJob(req, res, id)) return;
  const b = req.body || {};
  const j = setStage(id, String(b.stage || ''), b.note !== undefined ? String(b.note) : undefined);
  if (j) osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office: j.office, module: 'service', action: 'job.stage', subject_type: 'est_job', subject_id: id, new_summary: j.stage });
  res.status(j ? 200 : 400).json(j ? { ok: true, job: j } : { ok: false, error: 'bad stage' });
});

router.delete('/api/jobboard/:id(\\d+)', requireOs(P.jobs_write), (req, res) => {
  const id = Number(req.params.id);
  const j = scopeJob(req, res, id); if (!j) return;
  const ok = deleteJob(id);
  if (ok) osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office: j.office, module: 'service', action: 'job.delete', subject_type: 'est_job', subject_id: id });
  res.json({ ok });
});

export default router;
