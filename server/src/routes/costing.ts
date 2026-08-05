import { Router } from 'express';
import { getCostingSummary, draftChangeOrder } from '../services/costingAgent';

/**
 * Job Costing (Phase 6). GET serves every job worst-margin-first (margin computed on read,
 * never stored), the flagged focus job and its drafted change order. Drafting a change order
 * is gated — it quotes the customer a price. live:false.
 */
const router = Router();

router.get('/api/costing', (req, res) => {
  res.json(getCostingSummary(String(req.query.office || '')));
});

router.post('/api/costing/:id/change-order', (req, res) => {
  try {
    const r = draftChangeOrder(Number(req.params.id));
    res.json({ ok: true, ...r, live: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
