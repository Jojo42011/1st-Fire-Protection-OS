import { Router } from 'express';
import {
  createRequest,
  getRequest,
  listRequests,
  completeItem,
  approveItem,
  rejectItem,
  getFormOptions,
} from '../services/onboardingAgent';
import {
  createIntakeLink,
  listIntakeLinks,
  resendIntakeLink,
  nudgeIntakeLink,
  voidIntakeLink,
  getSubmission,
} from '../services/intakeLinks';
import { operatingOffices } from '../os/office';
import { getDb } from '../db/index';

const router = Router();

/** The real offices + active job titles the manager-facing intake form offers. App-gated only (no
 * People identity needed), so the preview overlay and the public token form show the same true set. */
router.get('/api/onboarding/form-options', (_req, res) => {
  let positions: string[] = [];
  try {
    positions = (getDb().prepare(`SELECT name FROM job_positions WHERE active = 1 ORDER BY name`).all() as { name: string }[])
      .map((r) => r.name)
      .filter(Boolean);
  } catch {
    positions = [];
  }
  res.json({ offices: operatingOffices().map((o) => o.label), positions });
});
const actor = (req: any): string => (req.user?.email as string) || (req.body && req.body.by) || 'operator';

/** The board: every onboarding request with its progress rollup, plus the form option catalogs. */
router.get('/api/onboarding', (_req, res) => {
  res.json({ requests: listRequests(), options: getFormOptions() });
});

/** Create a new onboarding request and auto-route it into gated items. */
router.post('/api/onboarding', (req, res) => {
  try {
    const out = createRequest(req.body || {});
    res.json({ ok: true, request: out.request, items: out.items });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** One request: the record + its items grouped by owner + the rollup. (id is numeric so the
 *  /api/onboarding/intake-links routes below are not captured here.) */
router.get('/api/onboarding/:id(\\d+)', (req, res) => {
  const out = getRequest(Number(req.params.id));
  if (!out) return res.status(404).json({ ok: false, error: 'request not found' });
  res.json({ ok: true, ...out });
});

/** Complete a task (task -> done). */
router.post('/api/onboarding/items/:id/complete', (req, res) => {
  try {
    res.json({ ok: true, item: completeItem(Number(req.params.id), (req.body && req.body.by) || 'operator') });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Approve an approval (the human gate). */
router.post('/api/onboarding/items/:id/approve', (req, res) => {
  try {
    res.json({ ok: true, item: approveItem(Number(req.params.id), (req.body && req.body.by) || 'operator') });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Reject an approval (the human gate). */
router.post('/api/onboarding/items/:id/reject', (req, res) => {
  try {
    res.json({ ok: true, item: rejectItem(Number(req.params.id), (req.body && req.body.by) || 'operator') });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/* ─────────────────────────── intake links (tokenised invites) ─────────────────────────── */

/** The intake-link list for the Onboarding screen. */
router.get('/api/onboarding/intake-links', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, links: listIntakeLinks(base) });
});

/** Create a new single-use link; returns the shareable URL (nothing is emailed on its own). */
router.post('/api/onboarding/intake-links', (req, res) => {
  const b = req.body || {};
  const { link, token } = createIntakeLink({
    job_title: b.job_title,
    office: b.office,
    recipient_name: b.recipient_name,
    recipient_email: b.recipient_email,
    created_by: actor(req),
  });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, link, url: `${base}/intake/${token}` });
});

/** Resend: void the old token, issue a fresh one for the same recipient. */
router.post('/api/onboarding/intake-links/:id/resend', (req, res) => {
  const out = resendIntakeLink(Number(req.params.id), actor(req));
  if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, link: out.link, url: `${base}/intake/${out.token}` });
});

/** Nudge: record that a reminder was due (no email backend yet). */
router.post('/api/onboarding/intake-links/:id/nudge', (req, res) => {
  const ok = nudgeIntakeLink(Number(req.params.id));
  res.json({ ok, error: ok ? undefined : 'not_nudgeable' });
});

/** Discard: void an outstanding link so it can no longer be opened or submitted. */
router.post('/api/onboarding/intake-links/:id/void', (req, res) => {
  const out = voidIntakeLink(Number(req.params.id));
  if (!out.ok) return res.status(out.reason === 'not_found' ? 404 : 409).json(out);
  res.json({ ok: true });
});

/** The submitted values behind one link (View submission). */
router.get('/api/onboarding/intake-links/:id/submission', (req, res) => {
  const sub = getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ ok: false, error: 'no_submission' });
  res.json({ ok: true, submission: sub });
});

export default router;
