import { Router } from 'express';
import { getDb } from '../db/index';
import { draftReviewRequest, draftReviewReply, getReputationSummary } from '../services/reviewAgent';
import { integrationConnected } from '../config/integrations';
import { createApproval } from './approvals';
import {
  discoverOffices, getTargets, setTarget, setTargetActive, getMode, setMode,
  runReviewSweep, reviewRequestQueue, reviewRequestSummary, sendReviewRequest, sendPending,
} from '../services/reviewRequests';
import { pullCompletedJobs } from '../services/servicetradeSync';

const router = Router();

/* ---------- Google review requests, routed per office (live ServiceTrade) ---------- */

// Offices discovered from real jobs + their Google-link mapping state + queue summary.
router.get('/api/reviews/targets', (_req, res) => {
  res.json({ offices: discoverOffices(), targets: getTargets(), summary: reviewRequestSummary() });
});

// Map an office to its Google review link (accepts a review URL or a bare place id).
router.post('/api/reviews/targets', (req, res) => {
  try {
    const officeId = String(req.body?.office_id || '').trim();
    const link = String(req.body?.link || '').trim();
    if (!officeId || !link) return res.status(400).json({ ok: false, error: 'office_id and link required' });
    const phone = req.body?.phone != null ? String(req.body.phone) : null;
    const t = setTarget(officeId, req.body?.office_name != null ? String(req.body.office_name) : null, link, phone);
    res.json({ ok: true, target: t });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.post('/api/reviews/targets/:officeId/active', (req, res) => {
  setTargetActive(String(req.params.officeId), !!req.body?.active);
  res.json({ ok: true });
});

// Switch hold <-> auto send.
router.post('/api/reviews/mode', (req, res) => {
  const mode = req.body?.mode === 'auto' ? 'auto' : 'hold';
  setMode(mode);
  res.json({ ok: true, mode });
});

// Rebuild all UNSENT held/approved requests with the current message template (leaves sent ones
// alone), then re-sweep. Safe cleanup after a copy change.
router.post('/api/reviews/regenerate', async (_req, res) => {
  try {
    const db = getDb();
    db.prepare(`DELETE FROM review_requests WHERE source = 'servicetrade' AND status != 'sent'`).run();
    db.prepare(
      `UPDATE crm_jobs SET review_requested = 0
        WHERE source = 'servicetrade' AND id NOT IN (
          SELECT job_id FROM review_requests WHERE status = 'sent' AND job_id IS NOT NULL)`
    ).run();
    const sweep = await runReviewSweep();
    res.json({ ok: true, ...sweep, summary: reviewRequestSummary() });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// Send the exact branded customer email as a preview (default) to confirm how it looks + that
// Graph Mail.Send works. Pass {to} to choose a recipient (defaults to the from-mailbox).
router.post('/api/reviews/test-send', async (req, res) => {
  const { mailConfigured, mailFrom, sendMail } = await import('../services/msGraphMail');
  const { renderSample } = await import('../services/reviewRequests');
  if (!mailConfigured()) return res.status(400).json({ ok: false, error: 'mail not configured (need MS_MAIL_FROM + Mail.Send)' });
  const to = String(req.body?.to || mailFrom() || '').trim();
  if (!to) return res.status(400).json({ ok: false, error: 'no recipient' });
  const sample = renderSample(req.body?.office_name);
  const r = await sendMail(to, `[PREVIEW] ${sample.subject}`, sample.html, sample.fromName);
  res.json(r.ok ? { ok: true, to } : { ok: false, error: r.error });
});

// Backfill completed jobs (last ~90 days) so offices + contacts populate, then sweep. One-time
// bootstrap; after this the scheduled sync keeps completed jobs current incrementally.
router.post('/api/reviews/backfill', async (_req, res) => {
  try {
    const pull = await pullCompletedJobs();
    const sweep = await runReviewSweep();
    res.json({ ok: true, pulled: pull.pulled, ...sweep, summary: reviewRequestSummary() });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// Queue completed jobs into requests (held or auto-sent per mode). Manual trigger for the screen.
router.post('/api/reviews/sweep', async (_req, res) => {
  try {
    const r = await runReviewSweep();
    res.json({ ok: true, ...r, summary: reviewRequestSummary() });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// The routed request queue (held / sent).
router.get('/api/reviews/queue', (_req, res) => {
  res.json({ requests: reviewRequestQueue(), summary: reviewRequestSummary() });
});

// Send queued requests up to today's remaining cap (the "Send all held" button).
router.post('/api/reviews/send-batch', async (_req, res) => {
  try {
    const r = await sendPending(false);
    res.json({ ok: true, ...r, summary: reviewRequestSummary() });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// Approve & send one request now (via Microsoft 365 Graph).
router.post('/api/reviews/queue/:id/send', async (req, res) => {
  try {
    const r = await sendReviewRequest(Number(req.params.id));
    res.json(r);
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

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
