import { Router } from 'express';
import { getDb } from '../db/index';
import { draftReviewRequest, draftReviewReply, getReputationSummary } from '../services/reviewAgent';
import { integrationConnected } from '../config/integrations';
import { createApproval } from './approvals';

const router = Router();

router.get('/api/reviews', (_req, res) => {
  const db = getDb();
  const reviews = db.prepare(`SELECT * FROM reviews ORDER BY received_at DESC`).all();
  const requests = db
    .prepare(`SELECT * FROM review_requests WHERE status IN ('draft','approved') ORDER BY created_at DESC`)
    .all();
  const jobs = db.prepare(`SELECT * FROM jobs WHERE requested = 0 ORDER BY completed_at DESC`).all();
  res.json({
    summary: getReputationSummary(),
    reviews,
    requests,
    pendingJobs: jobs,
    live: integrationConnected('google_business'),
  });
});

router.post('/api/reviews/request/:jobId', async (req, res) => {
  try {
    const r = await draftReviewRequest(Number(req.params.jobId));
    res.json({ ok: true, request: r });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.post('/api/reviews/:id/draft-reply', async (req, res) => {
  try {
    const r = await draftReviewReply(Number(req.params.id));
    // Dual-write into the unified approvals inbox (best-effort).
    try {
      const id = Number(req.params.id);
      const rev = getDb().prepare('SELECT author, stars, source FROM reviews WHERE id = ?').get(id) as
        | { author: string; stars: number; source: string }
        | undefined;
      if (rev) {
        const src = (rev.source || 'google').replace(/^\w/, (c) => c.toUpperCase());
        createApproval({
          agent_key: 'reviews',
          kind: 'publish',
          risk: rev.stars >= 4 ? 'routine' : 'sensitive',
          title: `Reply to ${rev.author} ${'★'.repeat(Math.max(0, Math.min(5, rev.stars)))}`,
          stake: src,
          body: r.body,
          trail: 'Posts on your Google Business Profile',
          subject_type: 'review',
          subject_id: id,
        });
      }
    } catch {
      /* inbox mirror is best-effort */
    }
    res.json({ ok: true, reply: r });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.post('/api/reviews/:id/approve-reply', (req, res) => {
  const db = getDb();
  const publishable = integrationConnected('google_business');
  const status = publishable ? 'published' : 'approved';
  db.prepare(`UPDATE reviews SET reply_status = ? WHERE id = ?`).run(status, Number(req.params.id));
  res.json({ ok: true, status, published: publishable });
});

router.post('/api/reviews/requests/:id/approve', (req, res) => {
  const db = getDb();
  const sendable = integrationConnected('gmail') || integrationConnected('sms');
  const status = sendable ? 'sent' : 'approved';
  db.prepare(`UPDATE review_requests SET status = ? WHERE id = ?`).run(status, Number(req.params.id));
  res.json({ ok: true, status, sent: sendable });
});

export default router;
