import express, { Router } from 'express';
import { recordReviewEvent, reviewPageStats, parseEventBody, REVIEW_PAGE_URL } from '../services/reviewLanding';

const router = Router();

/** The badge page moved to the company website. Keep old badge links (and their ?src/&b) working. */
router.get(['/review', '/review/'], (req, res) => {
  const q = req.originalUrl.indexOf('?');
  res.redirect(301, REVIEW_PAGE_URL + (q >= 0 ? req.originalUrl.slice(q) : ''));
});

/** Public: analytics beacon from the website. Always 204 so a bad event never surfaces to a customer. */
router.post('/api/review-page/events', express.text({ type: 'text/plain', limit: '4kb' }), (req, res) => {
  try { recordReviewEvent(parseEventBody(req.body), req.get('user-agent') || ''); } catch { /* never fail the page */ }
  res.status(204).end();
});

/** Staff: counts for the Review requests screen. */
router.get('/api/review-page/stats', (req, res) => {
  const days = Math.min(365, Math.max(1, Math.round(Number(req.query.days) || 30)));
  res.json(reviewPageStats(days));
});

export default router;
