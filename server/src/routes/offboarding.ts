import { Router } from 'express';
import {
  createOffboarding,
  getOffboarding,
  listOffboarding,
  decideItem,
  cancelOffboarding,
  getPolicy,
  setPolicy,
  itemDept,
  ItemFilter,
  hasDirectory,
  sendOffboardingEmail,
  sendDepartmentDigest,
} from '../services/offboardingAgent';
import { backlogCandidates, createFromBacklog } from '../services/offboardingBacklog';
import { listActiveEmployeesForOffboarding, listManagers, buildItemJob, isDcExecutable } from '../services/offboardingAgent';
import { buildExchangeScript, buildDcOffboardingScript, buildCloudOffboardingScript } from '../services/offboardingExchange';
import { getDb } from '../db/index';
import { currentContext } from '../os/scope';
import { enqueue, latestJobForRef } from '../services/dcJobs';
import { completeItemByScript } from '../services/offboardingAgent';
import { decider, sendDenied } from '../people/decider';
import { isCloudExecutable, cloudActionLabel, runCloudAction, graphOffboardConfigured, offboardingPermissionCheck } from '../services/msGraphOffboard';
import { osAudit, actorLabel } from '../os/audit';
import { taskScope, seesOffboardingItem, scopeSummary, TaskScope } from '../people/taskScope';

const router = Router();
const actor = (req: any): string => (req.user?.email as string) || (req.body && req.body.by) || 'operator';

// Running a live cloud action against Microsoft 365 is an IT/admin operation. A department viewer who
// only sees their own tasks (HR, Accounting, Manager) may not trigger it.
function canRunCloud(req: any): boolean {
  const roles: string[] = currentContext(req).user?.roles || [];
  return roles.some((r) => ['it', 'people_admin', 'executive'].includes(r));
}
// The DC / Exchange / cloud scripts and the backlog sweep are IT and admin tools.
function itOrAdmin(req: any): boolean {
  const s = taskScope(currentContext(req).user);
  return s.all || s.offboarding.has('it');
}

// Department scoping: each department sees only its own offboarding steps (see people/taskScope.ts).
// Admins and executives see all and may narrow to one department with ?dept= (or the older ?owner=).
function scopeFor(req: any): { see: ItemFilter; scope: TaskScope; viewer: ReturnType<typeof scopeSummary> & { canSeeAll: boolean } } {
  const user = currentContext(req).user;
  const scope = taskScope(user);
  const want = String(req.query.dept || req.query.owner || '').trim();
  const see: ItemFilter = scope.all
    ? (want ? (item: any) => itemDept(item) === want : null)
    : (item: any, request: any) => seesOffboardingItem(scope, item, request);
  return { see, scope, viewer: { ...scopeSummary(scope, user), canSeeAll: scope.all } };
}
/** The item and its request, when the signed-in person may see the item; else null. */
function visibleItem(req: any, itemId: number): any | null {
  const db = getDb();
  const item = db.prepare(`SELECT * FROM offboarding_items WHERE id = ?`).get(itemId) as any;
  if (!item) return null;
  const request = db.prepare(`SELECT * FROM offboarding_requests WHERE id = ?`).get(item.request_id) as any;
  return seesOffboardingItem(taskScope(currentContext(req).user), item, request) ? item : null;
}

/** The board: every offboarding request with its (department-scoped) progress rollup, plus policy. */
router.get('/api/offboarding', (req, res) => {
  const s = scopeFor(req);
  res.json({ ok: true, requests: listOffboarding(s.see), policy: getPolicy(), viewer: s.viewer });
});

/** Create an offboarding request (manual). Routes it into the dated SOP items. */
router.post('/api/offboarding', (req, res) => {
  try {
    const out = createOffboarding({ ...(req.body || {}), created_by: actor(req) });
    res.json({ ok: true, request: out.request, items: out.items });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Active employees for the offboarding picker, each with manager resolved to an email. */
router.get('/api/offboarding/people', (_req, res) => {
  res.json({ ok: true, employees: listActiveEmployeesForOffboarding(), managers: listManagers() });
});

/** Enqueue a DC agent job for one offboarding item (disable / remove groups / hide GAL / delete).
 *  Destructive deletes must be approved first. Returns the queued job. */
router.post('/api/offboarding/items/:id(\\d+)/run-on-dc', (req, res) => {
  const itemId = Number(req.params.id);
  const db = getDb();
  const item = db.prepare(`SELECT * FROM offboarding_items WHERE id = ?`).get(itemId) as any;
  if (!item || !visibleItem(req, itemId)) return res.status(404).json({ ok: false, error: 'item not found' });
  if (!isDcExecutable(item.action_code)) return res.status(400).json({ ok: false, error: 'this step is not run on the DC (mailbox/cloud steps run elsewhere)' });
  if (item.kind === 'approval' && item.status !== 'approved') {
    return res.status(400).json({ ok: false, error: 'approve this step before running it on the DC' });
  }
  const built = buildItemJob(itemId);
  if (!built.ok) return res.status(400).json({ ok: false, error: built.error });
  const job = enqueue(built.kind as any, built.payload, { type: 'offboarding_item', id: itemId }, actor(req));
  res.json({ ok: true, job, kind: built.kind });
});

/** What Microsoft Graph application permissions the connected app actually holds, versus what
 *  server-side cloud offboarding needs. Read from the app's own token, so it is definitive. */
router.get('/api/offboarding/cloud-permissions', async (_req, res) => {
  res.json({ ok: true, ...(await offboardingPermissionCheck()) });
});

/**
 * Run one cloud offboarding step SERVER-SIDE via Microsoft Graph (no PowerShell, no laptop modules).
 * Covers: block sign-in + revoke sessions, remove license, auto-reply, forward to manager, and the
 * OneDrive/SharePoint delegation. On success the checklist item is marked done; every attempt is audited.
 */
router.post('/api/offboarding/items/:id(\\d+)/run-in-cloud', async (req, res) => {
  const itemId = Number(req.params.id);
  const db = getDb();
  const item = db.prepare(`SELECT * FROM offboarding_items WHERE id = ?`).get(itemId) as any;
  if (!item || !visibleItem(req, itemId)) return res.status(404).json({ ok: false, error: 'item not found' });
  if (!isCloudExecutable(item.action_code)) {
    return res.status(400).json({ ok: false, error: 'this step is not a server-runnable cloud action (it runs on the DC or in Exchange Online)' });
  }
  if (!canRunCloud(req)) return res.status(403).json({ ok: false, error: 'only IT or an admin can run cloud offboarding actions' });
  if (!graphOffboardConfigured()) return res.status(400).json({ ok: false, error: 'Microsoft Graph is not connected' });

  const request = db.prepare(`SELECT * FROM offboarding_requests WHERE id = ?`).get(item.request_id) as any;
  if (!request) return res.status(404).json({ ok: false, error: 'request not found' });

  const ctx = currentContext(req);
  const result = await runCloudAction(item.action_code, request);
  osAudit({
    actor: actorLabel(ctx), actor_email: ctx.user?.email ?? null, office: request.office ?? null,
    module: 'offboarding', action: result.ok ? 'offboarding.cloud_run' : 'offboarding.cloud_run_failed',
    subject_type: 'offboarding_item', subject_id: itemId,
    detail: `${cloudActionLabel(item.action_code)} for ${request.upn || request.name}${result.ok ? (result.detail ? ': ' + result.detail : '') : ': ' + (result.error || 'failed')}`,
  });
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error, action: item.action_code });

  completeItemByScript(itemId); // mark the board item done now that the live action succeeded
  const updated = db.prepare(`SELECT * FROM offboarding_items WHERE id = ?`).get(itemId);
  res.json({ ok: true, item: updated, detail: result.detail || cloudActionLabel(item.action_code), already: result.already });
});

/** Send one department its still-open tasks as a single digest email to its shared mailbox. */
router.post('/api/offboarding/:id(\\d+)/email-department', async (req, res) => {
  const dept = String(req.body?.dept || '').trim();
  const sc = taskScope(currentContext(req).user);
  if (!sc.all && !sc.offboarding.has(dept)) return res.status(403).json({ ok: false, error: "That is another team's list." });
  const out = await sendDepartmentDigest(Number(req.params.id), dept, actor(req));
  const ctx = currentContext(req);
  osAudit({
    actor: actorLabel(ctx), actor_email: ctx.user?.email ?? null,
    module: 'offboarding', action: out.ok ? 'offboarding.dept_email_sent' : 'offboarding.dept_email_failed',
    subject_type: 'offboarding_request', subject_id: Number(req.params.id),
    detail: `${dept} digest to ${out.to || '(no mailbox)'}${out.ok ? ` (${out.count} task${out.count === 1 ? '' : 's'})` : ': ' + (out.error || 'failed')}`,
  });
  if (!out.ok) return res.status(400).json({ ok: false, error: out.error });
  res.json({ ok: true, to: out.to, count: out.count });
});

/** Send the shared-mailbox notification email for one offboarding task (from offboarding@). */
router.post('/api/offboarding/items/:id(\\d+)/send-email', async (req, res) => {
  const itemId = Number(req.params.id);
  if (!visibleItem(req, itemId)) return res.status(404).json({ ok: false, error: 'item not found' });
  const out = await sendOffboardingEmail(itemId, actor(req));
  const ctx = currentContext(req);
  osAudit({
    actor: actorLabel(ctx), actor_email: ctx.user?.email ?? null,
    module: 'offboarding', action: out.ok ? 'offboarding.email_sent' : 'offboarding.email_failed',
    subject_type: 'offboarding_item', subject_id: itemId,
    detail: `notify ${out.to || '(no mailbox)'}${out.ok ? '' : ': ' + (out.error || 'failed')}`,
  });
  if (!out.ok) return res.status(400).json({ ok: false, error: out.error });
  res.json({ ok: true, to: out.to });
});

/** Latest DC job status for one offboarding item, for the UI to poll. */
router.get('/api/offboarding/items/:id(\\d+)/job', (req, res) => {
  if (!visibleItem(req, Number(req.params.id))) return res.status(404).json({ ok: false, error: 'item not found' });
  const j = latestJobForRef('offboarding_item', Number(req.params.id));
  res.json({ ok: true, job: j ? { id: j.id, kind: j.kind, status: j.status, error: j.error, finished_at: j.finished_at } : null });
});

/** The Exchange Online offboarding script (mailbox/license/GAL/forwarding) for one request. */
router.get('/api/offboarding/:id(\\d+)/exchange-script', (req, res) => {
  if (!itOrAdmin(req)) return res.status(403).json({ ok: false, error: 'IT or an admin only.' });
  const out = buildExchangeScript(Number(req.params.id));
  res.status(out.ok ? 200 : 400).json(out);
});

/** The on-prem AD offboarding script (disable + remove groups), run on a domain controller. */
router.get('/api/offboarding/:id(\\d+)/dc-script', (req, res) => {
  if (!itOrAdmin(req)) return res.status(403).json({ ok: false, error: 'IT or an admin only.' });
  const out = buildDcOffboardingScript(Number(req.params.id));
  res.status(out.ok ? 200 : 400).json(out);
});

/** The cloud offboarding script (Exchange Online + Graph): convert to shared, remove license, revoke
 *  sessions, forward, auto-reply. Run on your own computer. */
router.get('/api/offboarding/:id(\\d+)/cloud-script', (req, res) => {
  if (!itOrAdmin(req)) return res.status(403).json({ ok: false, error: 'IT or an admin only.' });
  const out = buildCloudOffboardingScript(Number(req.params.id));
  res.status(out.ok ? 200 : 400).json(out);
});

/** The editable retention policy (forward + retain days). */
router.get('/api/offboarding/policy', (_req, res) => res.json({ ok: true, policy: getPolicy() }));
router.put('/api/offboarding/policy', (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, policy: setPolicy({ forwardDays: b.forwardDays, retainDays: b.retainDays }) });
});

/** The backlog sweep: already-terminated AD accounts with no offboarding request yet. */
router.get('/api/offboarding/backlog', (req, res) => {
  if (!itOrAdmin(req)) return res.status(403).json({ ok: false, error: 'IT or an admin only.' });
  res.json({ ok: true, candidates: backlogCandidates() });
});

/** Create offboarding requests for the selected backlog accounts (by object_guid). */
router.post('/api/offboarding/backlog/create', (req, res) => {
  if (!itOrAdmin(req)) return res.status(403).json({ ok: false, error: 'IT or an admin only.' });
  const guids: string[] = Array.isArray(req.body?.guids) ? req.body.guids : [];
  if (!guids.length) return res.status(400).json({ ok: false, error: 'no accounts selected' });
  res.json({ ok: true, ...createFromBacklog(guids, actor(req)) });
});

/** One request: the record + its (department-scoped) items + the rollup. */
router.get('/api/offboarding/:id(\\d+)', (req, res) => {
  const s = scopeFor(req);
  const out = getOffboarding(Number(req.params.id), s.see);
  if (!out) return res.status(404).json({ ok: false, error: 'request not found' });
  if (!s.scope.all && !out.items.length) return res.status(404).json({ ok: false, error: 'No steps for your team on this person.' });
  const no_directory = !hasDirectory(out.request);
  res.json({ ok: true, ...out, no_directory, viewer: s.viewer });
});

/** Cancel a request. */
router.post('/api/offboarding/:id(\\d+)/cancel', (req, res) => {
  res.json({ ok: cancelOffboarding(Number(req.params.id), actor(req)) });
});

/** Decide an item: complete a task, approve/reject an approval, or skip a step. Only a signed-in
 *  person whose department owns the item may decide it, and it is recorded under their email. */
for (const verb of ['complete', 'approve', 'reject', 'skip'] as const) {
  router.post(`/api/offboarding/items/:id/${verb}`, (req, res) => {
    const d = decider(req, () => !!visibleItem(req, Number(req.params.id)));
    if (!d.ok) return sendDenied(res, d);
    try {
      res.json({ ok: true, item: decideItem(Number(req.params.id), verb, d.actor) });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });
}

export default router;
