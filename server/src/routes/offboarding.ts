import { Router } from 'express';
import {
  createOffboarding,
  getOffboarding,
  listOffboarding,
  decideItem,
  cancelOffboarding,
  getPolicy,
  setPolicy,
  ownersForRoles,
} from '../services/offboardingAgent';
import { backlogCandidates, createFromBacklog } from '../services/offboardingBacklog';
import { listActiveEmployeesForOffboarding, listManagers, buildItemJob, isDcExecutable } from '../services/offboardingAgent';
import { buildExchangeScript, buildDcOffboardingScript, buildCloudOffboardingScript } from '../services/offboardingExchange';
import { getDb } from '../db/index';
import { currentContext } from '../os/scope';
import { enqueue, latestJobForRef } from '../services/dcJobs';
import { completeItemByScript } from '../services/offboardingAgent';
import { isCloudExecutable, cloudActionLabel, runCloudAction, graphOffboardConfigured } from '../services/msGraphOffboard';
import { osAudit, actorLabel } from '../os/audit';

const router = Router();
const actor = (req: any): string => (req.user?.email as string) || (req.body && req.body.by) || 'operator';

// Running a live cloud action against Microsoft 365 is an IT/admin operation. A department viewer who
// only sees their own tasks (HR, Accounting, Manager) may not trigger it.
function canRunCloud(req: any): boolean {
  const roles: string[] = currentContext(req).user?.roles || [];
  if (!roles.length) return true; // legacy shared-password session (no mapped identity): allowed, audited
  return roles.some((r) => ['it', 'people_admin', 'executive'].includes(r));
}

// Department scoping: each department sees only its own offboarding tasks. Admins/execs (allowed=null)
// see all and may narrow to one department via ?owner=; a department member is locked to their own.
function scopeOwners(req: any): { owners: string[] | null; allowed: string[] | null; canSeeAll: boolean } {
  const ctx = currentContext(req);
  const allowed = ownersForRoles(ctx.user?.roles);
  const requested = String(req.query.owner || '').trim();
  let owners = allowed;
  if (requested) {
    if (allowed === null) owners = [requested];
    else if (allowed.includes(requested)) owners = [requested];
  }
  return { owners, allowed, canSeeAll: allowed === null };
}

/** The board: every offboarding request with its (department-scoped) progress rollup, plus policy. */
router.get('/api/offboarding', (req, res) => {
  const s = scopeOwners(req);
  res.json({ ok: true, requests: listOffboarding(s.owners), policy: getPolicy(), viewer: { allowed: s.allowed, canSeeAll: s.canSeeAll } });
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
  if (!item) return res.status(404).json({ ok: false, error: 'item not found' });
  if (!isDcExecutable(item.action_code)) return res.status(400).json({ ok: false, error: 'this step is not run on the DC (mailbox/cloud steps run elsewhere)' });
  if (item.kind === 'approval' && item.status !== 'approved') {
    return res.status(400).json({ ok: false, error: 'approve this step before running it on the DC' });
  }
  const built = buildItemJob(itemId);
  if (!built.ok) return res.status(400).json({ ok: false, error: built.error });
  const job = enqueue(built.kind as any, built.payload, { type: 'offboarding_item', id: itemId }, actor(req));
  res.json({ ok: true, job, kind: built.kind });
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
  if (!item) return res.status(404).json({ ok: false, error: 'item not found' });
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

/** Latest DC job status for one offboarding item, for the UI to poll. */
router.get('/api/offboarding/items/:id(\\d+)/job', (req, res) => {
  const j = latestJobForRef('offboarding_item', Number(req.params.id));
  res.json({ ok: true, job: j ? { id: j.id, kind: j.kind, status: j.status, error: j.error, finished_at: j.finished_at } : null });
});

/** The Exchange Online offboarding script (mailbox/license/GAL/forwarding) for one request. */
router.get('/api/offboarding/:id(\\d+)/exchange-script', (req, res) => {
  const out = buildExchangeScript(Number(req.params.id));
  res.status(out.ok ? 200 : 400).json(out);
});

/** The on-prem AD offboarding script (disable + remove groups), run on a domain controller. */
router.get('/api/offboarding/:id(\\d+)/dc-script', (req, res) => {
  const out = buildDcOffboardingScript(Number(req.params.id));
  res.status(out.ok ? 200 : 400).json(out);
});

/** The cloud offboarding script (Exchange Online + Graph): convert to shared, remove license, revoke
 *  sessions, forward, auto-reply. Run on your own computer. */
router.get('/api/offboarding/:id(\\d+)/cloud-script', (req, res) => {
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
router.get('/api/offboarding/backlog', (_req, res) => {
  res.json({ ok: true, candidates: backlogCandidates() });
});

/** Create offboarding requests for the selected backlog accounts (by object_guid). */
router.post('/api/offboarding/backlog/create', (req, res) => {
  const guids: string[] = Array.isArray(req.body?.guids) ? req.body.guids : [];
  if (!guids.length) return res.status(400).json({ ok: false, error: 'no accounts selected' });
  res.json({ ok: true, ...createFromBacklog(guids, actor(req)) });
});

/** One request: the record + its (department-scoped) items + the rollup. */
router.get('/api/offboarding/:id(\\d+)', (req, res) => {
  const s = scopeOwners(req);
  const out = getOffboarding(Number(req.params.id), s.owners);
  if (!out) return res.status(404).json({ ok: false, error: 'request not found' });
  res.json({ ok: true, ...out, viewer: { allowed: s.allowed, canSeeAll: s.canSeeAll } });
});

/** Cancel a request. */
router.post('/api/offboarding/:id(\\d+)/cancel', (req, res) => {
  res.json({ ok: cancelOffboarding(Number(req.params.id), actor(req)) });
});

/** Decide an item: complete a task, approve/reject an approval, or skip a step. */
for (const verb of ['complete', 'approve', 'reject', 'skip'] as const) {
  router.post(`/api/offboarding/items/:id/${verb}`, (req, res) => {
    try {
      res.json({ ok: true, item: decideItem(Number(req.params.id), verb, actor(req)) });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });
}

export default router;
