import { Router } from 'express';
import { currentContext } from '../os/scope';
import { board, listJobs, getJob, createJob, updateJob, setStage, deleteJob, jobForQuote, STAGES } from '../services/jobsBoard';

/**
 * Phase 4 API: the project board of jobs spawned from won quotes. Mounted bare; office comes from the
 * client like the rest of the estimating family. Jobs are created automatically when a quote is won
 * (see the /send-status hook in estimatingBuilder), or manually here for standalone field work.
 */
const router = Router();
const O = (req: any): string => String(req.query.office || req.body?.office || '');
const who = (req: any): string | undefined => { const c = currentContext(req); return c.user?.display_name || c.user?.email || undefined; };

// Namespaced under /api/jobboard (not /api/jobs) so it never collides with the ServiceTrade job
// readiness endpoint (crm.ts owns GET /api/jobs). This is the local project board of won quotes.
router.get('/api/jobboard/stages', (_req, res) => res.json({ ok: true, stages: STAGES }));

router.get('/api/jobboard/board', (req, res) => res.json({ ok: true, ...board(O(req)) }));

router.get('/api/jobboard/list', (req, res) => res.json({ ok: true, jobs: listJobs(O(req), String(req.query.stage || '')) }));

router.post('/api/jobboard', (req, res) => {
  const j = createJob({ ...(req.body || {}), office: O(req), created_by: who(req) });
  res.json({ ok: true, job: j });
});

router.get('/api/jobboard/for-quote/:quoteId(\\d+)', (req, res) => {
  const j = jobForQuote(Number(req.params.quoteId));
  res.json({ ok: true, job: j });
});

router.get('/api/jobboard/:id(\\d+)', (req, res) => {
  const j = getJob(Number(req.params.id));
  res.status(j ? 200 : 404).json(j ? { ok: true, job: j } : { ok: false, error: 'not found' });
});

router.put('/api/jobboard/:id(\\d+)', (req, res) => {
  const j = updateJob(Number(req.params.id), req.body || {});
  res.status(j ? 200 : 404).json(j ? { ok: true, job: j } : { ok: false, error: 'not found' });
});

router.post('/api/jobboard/:id(\\d+)/stage', (req, res) => {
  const b = req.body || {};
  const j = setStage(Number(req.params.id), String(b.stage || ''), b.note !== undefined ? String(b.note) : undefined);
  res.status(j ? 200 : 400).json(j ? { ok: true, job: j } : { ok: false, error: 'bad stage' });
});

router.delete('/api/jobboard/:id(\\d+)', (req, res) => res.json({ ok: deleteJob(Number(req.params.id)) }));

export default router;
