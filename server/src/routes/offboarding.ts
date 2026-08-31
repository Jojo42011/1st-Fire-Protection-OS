import { Router } from 'express';
import {
  createOffboarding,
  getOffboarding,
  listOffboarding,
  decideItem,
  cancelOffboarding,
  getPolicy,
  setPolicy,
} from '../services/offboardingAgent';
import { backlogCandidates, createFromBacklog } from '../services/offboardingBacklog';
import { listActiveEmployeesForOffboarding, listManagers, buildItemJob, isDcExecutable } from '../services/offboardingAgent';
import { buildExchangeScript, buildDcOffboardingScript } from '../services/offboardingExchange';
import { getDb } from '../db/index';
import { enqueue, latestJobForRef } from '../services/dcJobs';

const router = Router();
const actor = (req: any): string => (req.user?.email as string) || (req.body && req.body.by) || 'operator';

/** The board: every offboarding request with its progress rollup, plus the policy defaults. */
router.get('/api/offboarding', (_req, res) => {
  res.json({ ok: true, requests: listOffboarding(), policy: getPolicy() });
});

/** Create an offboarding request (manual). Routes it into the dated SOP items. */
router.post('/api/offboarding', (req, res) => {
  try {
    const out = createOffboarding({ ...(req.body || {}), created_by: actor(req) });
    res.json({ ok: true, request: out.request, items: out.items });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Active employees for the offboarding picker, each with manager resolved to an email. */
router.get('/api/offboarding/people', (_req, res) => {
  res.json({ ok: true, employees: listActiveEmployeesForOffboarding(), managers: listManagers() });
});

/** Enqueue a DC agent job for one offboarding item (disable / remove groups / hide GAL / delete).
 *  Destructive deletes must be approved first. Returns the queued job. */
router.post('/api/offboarding/items/:id(\\d+)/run-on-dc', (req, res) => {
  const itemId = Number(req.params.id);
  const db = getDb();
  const item = db.prepare(`SELECT * FROM offboarding_items WHERE id = ?`).get(itemId) as any;
  if (!item) return res.status(404).json({ ok: false, error: 'item not found' });
  if (!isDcExecutable(item.action_code)) return res.status(400).json({ ok: false, error: 'this step is not run on the DC (mailbox/cloud steps run elsewhere)' });
  if (item.kind === 'approval' && item.status !== 'approved') {
    return res.status(400).json({ ok: false, error: 'approve this step before running it on the DC' });
  }
  const built = buildItemJob(itemId);
  if (!built.ok) return res.status(400).json({ ok: false, error: built.error });
  const job = enqueue(built.kind as any, built.payload, { type: 'offboarding_item', id: itemId }, actor(req));
  res.json({ ok: true, job, kind: built.kind });
});

/** Latest DC job status for one offboarding item, for the UI to poll. */
router.get('/api/offboarding/items/:id(\\d+)/job', (req, res) => {
  const j = latestJobForRef('offboarding_item', Number(req.params.id));
  res.json({ ok: true, job: j ? { id: j.id, kind: j.kind, status: j.status, error: j.error, finished_at: j.finished_at } : null });
});

/** The Exchange Online offboarding script (mailbox/license/GAL/forwarding) for one request. */
router.get('/api/offboarding/:id(\\d+)/exchange-script', (req, res) => {
  const out = buildExchangeScript(Number(req.params.id));
  res.status(out.ok ? 200 : 400).json(out);
});

/** The all-in-one DC offboarding script: AD steps + mailbox steps, each reporting back so the app
 *  marks only the tasks that actually succeed. */
router.get('/api/offboarding/:id(\\d+)/dc-script', (req, res) => {
  const out = buildDcOffboardingScript(Number(req.params.id));
  res.status(out.ok ? 200 : 400).json(out);
});

/** The editable retention policy (forward + retain days). */
router.get('/api/offboarding/policy', (_req, res) => res.json({ ok: true, policy: getPolicy() }));
router.put('/api/offboarding/policy', (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, policy: setPolicy({ forwardDays: b.forwardDays, retainDays: b.retainDays }) });
});

/** The backlog sweep: already-terminated AD accounts with no offboarding request yet. */
router.get('/api/offboarding/backlog', (_req, res) => {
  res.json({ ok: true, candidates: backlogCandidates() });
});

/** Create offboarding requests for the selected backlog accounts (by object_guid). */
router.post('/api/offboarding/backlog/create', (req, res) => {
  const guids: string[] = Array.isArray(req.body?.guids) ? req.body.guids : [];
  if (!guids.length) return res.status(400).json({ ok: false, error: 'no accounts selected' });
  res.json({ ok: true, ...createFromBacklog(guids, actor(req)) });
});

/** One request: the record + its items + the rollup. */
router.get('/api/offboarding/:id(\\d+)', (req, res) => {
  const out = getOffboarding(Number(req.params.id));
  if (!out) return res.status(404).json({ ok: false, error: 'request not found' });
  res.json({ ok: true, ...out });
});

/** Cancel a request. */
router.post('/api/offboarding/:id(\\d+)/cancel', (req, res) => {
  res.json({ ok: cancelOffboarding(Number(req.params.id), actor(req)) });
});

/** Decide an item: complete a task, approve/reject an approval, or skip a step. */
for (const verb of ['complete', 'approve', 'reject', 'skip'] as const) {
  router.post(`/api/offboarding/items/:id/${verb}`, (req, res) => {
    try {
      res.json({ ok: true, item: decideItem(Number(req.params.id), verb, actor(req)) });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });
}

export default router;
