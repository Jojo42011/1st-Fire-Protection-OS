import { Router } from 'express';
import {
  createRequest,
  getRequest,
  listRequests,
  completeItem,
  approveItem,
  rejectItem,
  getFormOptions,
  computerTierList,
  DOCK_PRICE,
} from '../services/onboardingAgent';
import {
  createIntakeLink,
  listIntakeLinks,
  resendIntakeLink,
  nudgeIntakeLink,
  voidIntakeLink,
  getSubmission,
  linkForEmail,
} from '../services/intakeLinks';
import { sendMail, mailCredsPresent } from '../services/msGraphMail';
import { intakeInviteHtml } from '../services/onboardingEmail';
import { senderFor, listMailSenders, setMailSender } from '../services/mailSenders';
import { operatingOffices } from '../os/office';
import { getDb } from '../db/index';
import { catalogByKind } from '../services/onboardingCatalog';
import { addUserToGroup, graphConfigured } from '../services/msGraphGroups';

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
  const catalog = {
    software: catalogByKind('software').map((s) => s.name),
    sharepoint: catalogByKind('sharepoint').map((s) => s.name),
    printers: catalogByKind('printer').map((p) => p.name),
    // Computers by purchase tier (with price), matching the asset-library cost model and live form.
    computers: computerTierList(),
    dockPrice: DOCK_PRICE,
  };
  res.json({ offices: operatingOffices().map((o) => o.label), positions, catalog });
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

/** Mail status + the per-purpose senders, so the UI can show what can send and from which mailbox. */
router.get('/api/onboarding/mail-status', (_req, res) => {
  const onboarding = senderFor('onboarding');
  res.json({ ok: true, credsPresent: mailCredsPresent(), configured: !!(mailCredsPresent() && onboarding), from: onboarding ? onboarding.address : null, senders: listMailSenders() });
});

/** Edit a purpose's sender address (which mailbox that flow sends AS). People admin / IT only. */
router.put('/api/mail/senders/:key', (req, res) => {
  const b = req.body || {};
  const out = setMailSender(req.params.key, { address: b.address, display_name: b.display_name }, actor(req));
  if (!out) return res.status(404).json({ ok: false, error: 'unknown_sender' });
  res.json({ ok: true, sender: out });
});

/** Email the current invite for a link to its manager, via Microsoft 365. Keyless-safe. */
async function emailInvite(id: number, base: string): Promise<{ ok: boolean; error?: string; to?: string }> {
  if (!mailCredsPresent()) return { ok: false, error: 'Microsoft 365 is not connected yet.' };
  const sender = senderFor('onboarding');
  if (!sender) return { ok: false, error: 'No sending mailbox set for onboarding invites. Set one in Integrations.' };
  const ctx = linkForEmail(id, base);
  if (!ctx) return { ok: false, error: 'link not found' };
  if (!ctx.recipient_email) return { ok: false, error: 'This link has no manager email to send to.' };
  if (!ctx.url) return { ok: false, error: 'This link can no longer be sent (submitted, expired, or discarded).' };
  const hireName = ctx.hire ? ctx.hire.name : null;
  const html = intakeInviteHtml({ managerName: ctx.recipient_name, hireName, role: ctx.job_title, office: ctx.office, start: ctx.hire ? ctx.hire.start_date : null, url: ctx.url });
  const out = await sendMail(ctx.recipient_email, `Set up ${hireName || 'a new hire'} at 1st Fire Protection`, html, { from: sender.address, fromName: sender.name });
  return out.ok ? { ok: true, to: ctx.recipient_email } : { ok: false, error: out.error };
}

/** Create a new single-use link; returns the shareable URL. Emails it to the manager when send=true. */
router.post('/api/onboarding/intake-links', async (req, res) => {
  const b = req.body || {};
  const { link, token } = createIntakeLink({
    employee_id: b.employee_id ? Number(b.employee_id) : undefined,
    job_title: b.job_title,
    office: b.office,
    recipient_name: b.recipient_name,
    recipient_email: b.recipient_email,
    created_by: actor(req),
  });
  const base = `${req.protocol}://${req.get('host')}`;
  let emailed: { ok: boolean; error?: string; to?: string } | undefined;
  if (b.send) emailed = await emailInvite(link.id, base);
  res.json({ ok: true, link, url: `${base}/intake/${token}`, emailed });
});

/** Send (or re-send) the invite email for an existing link. */
router.post('/api/onboarding/intake-links/:id/send', async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const out = await emailInvite(Number(req.params.id), base);
  res.status(out.ok ? 200 : 400).json(out);
});

/** Resend: void the old token, issue a fresh one for the same recipient. */
router.post('/api/onboarding/intake-links/:id/resend', (req, res) => {
  const out = resendIntakeLink(Number(req.params.id), actor(req));
  if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, link: out.link, url: `${base}/intake/${out.token}` });
});

/** Nudge: re-send the invite email to the manager and timestamp the reminder. Only for links that are
 *  still open (sent/opened). Keyless-safe: records the nudge even when mail is not connected. */
router.post('/api/onboarding/intake-links/:id/nudge', async (req, res) => {
  const id = Number(req.params.id);
  const recorded = nudgeIntakeLink(id);
  if (!recorded) return res.json({ ok: false, error: 'not_nudgeable' });
  const base = `${req.protocol}://${req.get('host')}`;
  const emailed = await emailInvite(id, base);
  res.json({ ok: true, nudged: true, emailed });
});

/** Discard: void an outstanding link so it can no longer be opened or submitted. */
router.post('/api/onboarding/intake-links/:id/void', (req, res) => {
  const out = voidIntakeLink(Number(req.params.id));
  if (!out.ok) return res.status(out.reason === 'not_found' ? 404 : 409).json(out);
  res.json({ ok: true });
});

/** Add a hire to an Entra security group (printer / access provisioning) via Microsoft Graph. */
router.post('/api/onboarding/add-to-group', async (req, res) => {
  const b = req.body || {};
  const upn = String(b.upn || '').trim();
  const out = await addUserToGroup(upn, { groupId: b.group_id, groupName: b.group_name });
  res.json(out);
});

/** Whether Graph is connected, so the UI can show auto-provisioning as available. */
router.get('/api/onboarding/graph-status', (_req, res) => {
  res.json({ ok: true, graphConfigured: graphConfigured() });
});

/** The submitted values behind one link (View submission). */
router.get('/api/onboarding/intake-links/:id/submission', (req, res) => {
  const sub = getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ ok: false, error: 'no_submission' });
  res.json({ ok: true, submission: sub });
});

export default router;
