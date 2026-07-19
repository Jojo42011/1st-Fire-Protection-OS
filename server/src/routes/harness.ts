import { Router } from 'express';
import { harnessState, runHarness, shipBuildOrder } from '../services/harness';

const router = Router();

/** The harness pipeline the UI renders: inbox (approved gaps) → staged build orders → shipped. */
router.get('/api/harness', (_req, res) => {
  res.json(harnessState());
});

/** Run the harness: turn every newly-approved gap into a staged build order (drafts the plan). */
router.post('/api/harness/run', async (_req, res) => {
  try {
    const r = await runHarness();
    res.json({ ok: true, ...r, state: harnessState() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/** Ship a staged build order — the human gate that puts the fix live. */
router.post('/api/harness/orders/:id/ship', (req, res) => {
  try {
    const r = shipBuildOrder(Number(req.params.id));
    res.json({ ...r, state: harnessState() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
