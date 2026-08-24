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
  provisionRequestGroups,
  discardRequest,
} from '../services/onboardingAgent';
import {
  createIntakeLink,
  listIntakeLinks,
  resendIntakeLink,
  nudgeIntakeLink,
  voidIntakeLink,
  getSubmission,
  linkForEmail,
  duplicateOnboardingWarning,
} from '../services/intakeLinks';
import { sendMail, mailCredsPresent } from '../services/msGraphMail';
import { intakeInviteHtml } from '../services/onboardingEmail';
import { senderFor, listMailSenders, setMailSender } from '../services/mailSenders';
import { operatingOffices } from '../os/office';
import { getDb } from '../db/index';
import { catalogByKind } from '../services/onboardingCatalog';
import { addUserToGroup, graphConfigured } from '../services/msGraphGroups';
import { buildProvisionScript, buildProvisionPlan, getAdSettings, setAdSettings } from '../services/adProvision';
import { enqueue, latestJobForRef } from '../services/dcJobs';
import { adOuOptions } from '../services/adAudit';
import { licenseStatusForRef } from '../services/entraLicensing';
import { visibleOwners, notifyOwners, ownerEmailMap, setOwnerEmail, ownerEmailPreview, sendOwnerEmailNow } from '../services/onboardingOwners';
import { currentUser } from '../people/authz';

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

/** Create a new onboarding request and auto-route it into gated items. Emails each owner lane's tasks
 *  to its routed address (hr@, IT MSP, accounting), best-effort. */
router.post('/api/onboarding', (req, res) => {
  try {
    const out = createRequest(req.body || {});
    res.json({ ok: true, request: out.request, items: out.items });
    const base = `${req.protocol}://${req.get('host')}`;
    void notifyOwners(out.request, out.items, base).catch(() => {});
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Generate the email for one owner lane of a request (recipient, subject, HTML + plain-text body),
 *  so it can be previewed, copied, and sent by hand, or sent now via the OS. Role-scoped. */
router.get('/api/onboarding/:id(\\d+)/owner-email/:owner', (req, res) => {
  const owner = req.params.owner as any;
  const vis = visibleOwners(currentUser(req));
  if (vis && !vis.has(owner)) return res.status(403).json({ ok: false, error: 'not visible to your role' });
  const base = `${req.protocol}://${req.get('host')}`;
  const out = ownerEmailPreview(Number(req.params.id), owner, base);
  if (!out) return res.status(404).json({ ok: false, error: 'request not found' });
  res.json({ ok: true, ...out });
});
router.post('/api/onboarding/:id(\\d+)/owner-email/:owner/send', async (req, res) => {
  const owner = req.params.owner as any;
  const vis = visibleOwners(currentUser(req));
  if (vis && !vis.has(owner)) return res.status(403).json({ ok: false, error: 'not visible to your role' });
  const base = `${req.protocol}://${req.get('host')}`;
  const out = await sendOwnerEmailNow(Number(req.params.id), owner, base);
  res.status(out.ok ? 200 : 400).json(out);
});

/** The owner->email routing map (HR, IT, accounting, ...) so a People admin can view and edit it. */
router.get('/api/onboarding/owner-emails', (_req, res) => res.json({ ok: true, emails: ownerEmailMap() }));
router.put('/api/onboarding/owner-emails', (req, res) => {
  const b = req.body || {};
  if (!b.owner) return res.status(400).json({ ok: false, error: 'owner required' });
  res.json({ ok: true, emails: setOwnerEmail(b.owner, b.email ?? null) });
});

/** Discard an onboarding request so it drops off the board (reversible; row kept). */
router.post('/api/onboarding/:id(\\d+)/discard', (req, res) => {
  res.json({ ok: discardRequest(Number(req.params.id), actor(req)) });
});

/** One request: the record + its items grouped by owner + the rollup. Owner lanes are filtered to
 *  the ones the viewer's role may see (HR sees HR lanes, not IT/accounting/owner approvals); People
 *  admins and executive approvers see all, and legacy shared-password sessions are unchanged. */
router.get('/api/onboarding/:id(\\d+)', (req, res) => {
  const out = getRequest(Number(req.params.id));
  if (!out) return res.status(404).json({ ok: false, error: 'request not found' });
  const vis = visibleOwners(currentUser(req));
  if (vis) {
    out.groups = out.groups.filter((g) => vis.has(g.owner as any));
    // Recompute the rollup from only the lanes this viewer can see, so counts match what they see.
    const items = out.groups.flatMap((g) => g.items);
    const total = items.length;
    const done = items.filter((i) => i.status === 'done' || i.status === 'approved').length;
    const settled = items.filter((i) => i.status !== 'pending').length;
    const pendingApprovals = items.filter((i) => i.kind === 'approval' && i.status === 'pending').length;
    out.rollup = { total, settled, done, pending: total - settled, pendingApprovals, progress: total ? Math.round((done / total) * 100) : 0 };
  }
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
  // Warn (do not block) if this hire already has onboarding in flight, so a duplicate is a choice.
  const warning = b.employee_id ? duplicateOnboardingWarning(Number(b.employee_id), link.id) : null;
  res.json({ ok: true, link, url: `${base}/intake/${token}`, emailed, warning });
});

/** Auto-provision the access-group items for a request via Microsoft Graph (adds the hire to each
 *  mapped Entra group and marks those items done). Bound hires with a work email only. */
router.post('/api/onboarding/:id(\\d+)/provision', async (req, res) => {
  const out = await provisionRequestGroups(Number(req.params.id), actor(req));
  res.status(out.ok ? 200 : 400).json(out);
});

/** Generate the on-prem AD PowerShell (New-ADUser + Add-ADGroupMember) for a hire. 1st Fire runs
 *  hybrid identity (AD synced to Entra), so accounts are created on-prem, not cloud-side via Graph.
 *  IT runs the returned script on a domain controller. Pure generation: it writes no state. */
router.get('/api/onboarding/:id(\\d+)/provision-script', (req, res) => {
  const out = buildProvisionScript(Number(req.params.id));
  res.status(out.ok ? 200 : 404).json(out);
});

/** Queue a create-user job for the DC agent to run (P2: onboarding auto-create). Returns the hire's
 *  UPN and the one-time password once, for the People admin to relay. Refuses until the target OU is
 *  set, so nothing is created into a placeholder container. */
router.post('/api/onboarding/:id(\\d+)/provision-job', (req, res) => {
  const id = Number(req.params.id);
  const plan = buildProvisionPlan(id);
  if (!plan.ok) return res.status(404).json({ ok: false, error: plan.error || 'request not found' });
  if (plan.ouIsPlaceholder) return res.status(400).json({ ok: false, error: 'Set the target OU in Integrations before creating accounts on the DC.' });
  const payload = {
    first: plan.first,
    last: plan.last,
    displayName: plan.displayName,
    sam: plan.sam,
    upn: plan.upn,
    email: plan.upn,
    ou: plan.ou,
    password: plan.password,
    changePasswordAtLogon: true,
    securityGroups: plan.securityGroups,
    licenseSku: plan.licenseSku, // the default SKU to assign cloud-side once the account syncs
  };
  const job = enqueue('ad_create_user', payload, { type: 'onboarding_request', id }, actor(req));
  res.json({ ok: true, job, upn: plan.upn, sam: plan.sam, password: plan.password, securityGroups: plan.securityGroups, warnings: plan.warnings });
});

/** The latest DC create-user job for a request + the license-queue status, for the UI. */
router.get('/api/onboarding/:id(\\d+)/provision-job', (req, res) => {
  const id = Number(req.params.id);
  const job = latestJobForRef('onboarding_request', id);
  const license = licenseStatusForRef('onboarding_request', id);
  res.json({ ok: true, job: job ? { id: job.id, status: job.status, error: job.error, finished_at: job.finished_at } : null, license });
});

/** The editable AD provisioning settings + the office and department lists + the real OUs from the AD
 *  mirror (so the UI can offer per-office and per-department OU dropdowns, not pasted DNs). */
router.get('/api/onboarding/ad-settings', (_req, res) => {
  let departments: string[] = [];
  try {
    departments = (getDb().prepare(`SELECT DISTINCT department FROM employees WHERE department IS NOT NULL AND department != '' ORDER BY department`).all() as { department: string }[])
      .map((r) => r.department);
  } catch { departments = []; }
  res.json({ ok: true, settings: getAdSettings(), offices: operatingOffices().map((o) => o.label), departments, ouOptions: adOuOptions() });
});
router.put('/api/onboarding/ad-settings', (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, settings: setAdSettings({ targetOu: b.targetOu, upnDomain: b.upnDomain, licenseSku: b.licenseSku, officeOuMap: b.officeOuMap, departmentOuMap: b.departmentOuMap }) });
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
