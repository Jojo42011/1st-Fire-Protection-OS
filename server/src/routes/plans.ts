import { Router } from 'express';
import { getRecurringSummary, draftRenewal, proposePlan } from '../services/planAgent';
import { syncPlans } from '../services/planSync';

/**
 * The Service-Plan Manager (Phase 4). When ServiceTrade recurring services are mirrored, GET
 * serves the real recurring-agreement book (office-scoped). Drafting a renewal or proposing a
 * plan is gated. Falls back to the seeded demo with no real data.
 */
const router = Router();

router.get('/api/plans', (req, res) => {
  res.json(getRecurringSummary(String(req.query.office || '')));
});

// Pull ServiceTrade recurring services into the mirror (read-only).
router.post('/api/plans/sync', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await syncPlans()) });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
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
