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
