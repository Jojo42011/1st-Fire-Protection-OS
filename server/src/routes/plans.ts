import { Router } from 'express';
import { getRecurringSummary, draftRenewal, proposePlan } from '../services/planAgent';

/**
 * The Service-Plan Manager (Phase 4). GET serves active agreements, the soonest renewal
 * draft, and finished jobs that could become plans. Drafting a renewal or proposing a plan
 * is gated. live:false.
 */
const router = Router();

router.get('/api/plans', (_req, res) => {
  res.json(getRecurringSummary());
});

router.post('/api/plans/:id/renewal', (req, res) => {
  try {
    const r = draftRenewal(Number(req.params.id), Boolean(req.body?.raiseRate));
    res.json({ ok: true, ...r, live: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.post('/api/plans/propose', (req, res) => {
  try {
    const r = proposePlan(Number(req.body?.index ?? req.body?.job_id ?? 0));
    res.json({ ok: true, ...r, live: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
