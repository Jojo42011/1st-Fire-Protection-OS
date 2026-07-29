import { Router } from 'express';
import { getPipelineSummary, draftFollowup, markOutcome } from '../services/closerAgent';

/**
 * The Closer (Phase 3). Reads the same quotes table the pipeline does, through a cadence
 * lens. GET serves the open quotes + the active last-call draft + the "why we lose" panel.
 * Drafting a follow-up is gated; marking an outcome logs the lost reason.
 */
const router = Router();

router.get('/api/closer', (_req, res) => {
  res.json(getPipelineSummary());
});

router.post('/api/closer/:quoteId/touch', (req, res) => {
  try {
    const r = draftFollowup(Number(req.params.quoteId));
    res.json({ ok: true, ...r, live: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.post('/api/closer/:quoteId/outcome', (req, res) => {
  try {
    const outcome = String(req.body?.outcome) === 'won' ? 'won' : 'lost';
    const r = markOutcome(Number(req.params.quoteId), outcome, req.body?.reason, req.body?.detail);
    res.json({ ...r, live: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
