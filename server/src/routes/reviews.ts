import { Router } from 'express';
import { getDb } from '../db/index';
import { draftReviewRequest, draftReviewReply, getReputationSummary } from '../services/reviewAgent';
import {
  enrollJob,
  setWorkflowStatus,
  completeWorkflowIfReviewed,
  runReviewCampaign,
  getReviewWorkflowState,
  Channel,
} from '../services/reviewWorkflow';
import { integrationConnected } from '../config/integrations';

const router = Router();

router.get('/api/reviews', (_req, res) => {
  const db = getDb();
  const reviews = db.prepare(`SELECT * FROM reviews ORDER BY received_at DESC`).all();
  const requests = db
    .prepare(`SELECT * FROM review_requests WHERE status IN ('draft','approved') ORDER BY created_at DESC`)
    .all();
  // Completed ServiceTrade work not yet enrolled/asked and not already reviewed.
  const jobs = db
    .prepare(`SELECT * FROM jobs WHERE requested = 0 AND reviewed = 0 ORDER BY completed_at DESC`)
    .all();
  res.json({
    summary: getReputationSummary(),
    reviews,
    requests,
    pendingJobs: jobs,
    workflow: getReviewWorkflowState(),
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

/* ─────────────── Review Campaign (staged review-request sequence) ─────────────── */

/** Enroll a completed job into the staged campaign (the human gate). */
router.post('/api/reviews/:jobId/enroll', (req, res) => {
  try {
    const channels = Array.isArray(req.body?.channels) ? (req.body.channels as Channel[]) : undefined;
    const wf = enrollJob(Number(req.params.jobId), channels);
    res.json({ ok: true, workflow: wf });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Pause / resume / stop a campaign. */
router.post('/api/reviews/workflow/:id/:action(pause|resume|stop)', (req, res) => {
  const map = { pause: 'paused', resume: 'active', stop: 'stopped' } as const;
  setWorkflowStatus(Number(req.params.id), map[req.params.action as keyof typeof map]);
  res.json({ ok: true });
});

/** Run every due stage now (demo trigger; the cron runs this on an interval). */
router.post('/api/reviews/workflow/run', async (_req, res) => {
  const result = await runReviewCampaign({ force: true });
  res.json({ ok: true, result });
});

/** Mark a job's customer as having left a review — completes the campaign (stop asking). */
router.post('/api/reviews/:jobId/mark-reviewed', (req, res) => {
  completeWorkflowIfReviewed(Number(req.params.jobId));
  res.json({ ok: true });
});

export default router;
