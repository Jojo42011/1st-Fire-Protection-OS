import { Router } from 'express';
import { renderReviewPage, recordReviewEvent, reviewPageStats } from '../services/reviewLanding';

const router = Router();

/** Public: the page every employee NFC badge opens. */
router.get('/review', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.type('html').send(renderReviewPage());
});

/** Public: analytics beacon from the page. Always 204 so a bad event never surfaces to a customer. */
router.post('/api/review-page/events', (req, res) => {
  try { recordReviewEvent(req.body, req.get('user-agent') || ''); } catch { /* never fail the page */ }
  res.status(204).end();
});

/** Staff: counts for the Review requests screen. */
router.get('/api/review-page/stats', (req, res) => {
  const days = Math.min(365, Math.max(1, Math.round(Number(req.query.days) || 30)));
  res.json(reviewPageStats(days));
});

export default router;
