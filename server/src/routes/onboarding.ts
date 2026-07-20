import { Router } from 'express';
import {
  createRequest,
  getRequest,
  listRequests,
  completeItem,
  approveItem,
  rejectItem,
  getFormOptions,
} from '../services/onboardingAgent';

const router = Router();

/** The board: every onboarding request with its progress rollup, plus the form option catalogs. */
router.get('/api/onboarding', (_req, res) => {
  res.json({ requests: listRequests(), options: getFormOptions() });
});

/** Create a new onboarding request and auto-route it into gated items. */
router.post('/api/onboarding', (req, res) => {
  try {
    const out = createRequest(req.body || {});
    res.json({ ok: true, request: out.request, items: out.items });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** One request: the record + its items grouped by owner + the rollup. */
router.get('/api/onboarding/:id', (req, res) => {
  const out = getRequest(Number(req.params.id));
  if (!out) return res.status(404).json({ ok: false, error: 'request not found' });
  res.json({ ok: true, ...out });
});

/** Complete a task (task -> done). */
router.post('/api/onboarding/items/:id/complete', (req, res) => {
  try {
    res.json({ ok: true, item: completeItem(Number(req.params.id), (req.body && req.body.by) || 'operator') });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Approve an approval (the human gate). */
router.post('/api/onboarding/items/:id/approve', (req, res) => {
  try {
    res.json({ ok: true, item: approveItem(Number(req.params.id), (req.body && req.body.by) || 'operator') });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Reject an approval (the human gate). */
router.post('/api/onboarding/items/:id/reject', (req, res) => {
  try {
    res.json({ ok: true, item: rejectItem(Number(req.params.id), (req.body && req.body.by) || 'operator') });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
