import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { ingestInventory, auditReport, lastSync, AdUserIn } from '../services/adAudit';
import { getDb } from '../db/index';
import { activeRoster } from '../services/peopleRoster';
import { syncIdentitiesFromM365 } from '../people/service';
import { discoverOffices as discoverReviewOffices, setTarget as setReviewTarget, setMode as setReviewMode, getMode as getReviewMode, rerenderQueued } from '../services/reviewRequests';
import { reviewImpactReport } from '../services/reviewImpact';
import { buildProvisionPlan } from '../services/adProvision';
import { spAccessAudit, flaggedRemovals } from '../services/spAccessAudit';
import { spDirectShares, removeSharePermission } from '../services/spDirectShares';
import { startScan, getScan, latestScan } from '../services/spScanRunner';
import { connectionInfo as googleConnInfo, accessToken as googleAccessToken, listAccounts as googleListAccounts, listLocations as googleListLocations } from '../services/googleBusiness';
import { claimPending, completeJob } from '../services/dcJobs';
import { listGroupsWithMembers, removeUserFromGroup } from '../services/msGraphGroups';
import { computeOfficeDrift, buildPilotGroupScript } from '../services/groupOfficeDrift';

/**
 * On-prem AD agent endpoints (P1: read-only inventory) + the audit dashboard read.
 *
 * The DC agent authenticates with a bearer token (AGENT_TOKEN, a Fly secret), not an app session:
 * the domain controller has no OS login. The session gate lets /api/ad-agent/* through (see auth.ts);
 * the token is enforced here. The dashboard read (/api/ad-audit) stays behind the normal user gate.
 */
const router = Router();

function agentToken(): string | null {
  const t = (process.env.AGENT_TOKEN || '').trim();
  return t ? t : null;
}

/** Constant-time bearer check. 503 when no token is configured, 401 when it does not match. */
function requireAgentToken(req: Request, res: Response, next: NextFunction): void {
  const expected = agentToken();
  if (!expected) { res.status(503).json({ ok: false, error: 'AD agent is not configured. Set AGENT_TOKEN on the server first.' }); return; }
  const hdr = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  const got = m ? m[1].trim() : '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) { res.status(401).json({ ok: false, error: 'bad agent token' }); return; }
  next();
}

router.use('/api/ad-agent', requireAgentToken);

/** Liveness + auth check the DC agent calls to confirm it can reach and authenticate to the OS. */
router.get('/api/ad-agent/ping', (_req, res) => {
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

/** Trigger the Microsoft 365 identity reconcile (stamp each employee's UPN/work email from Entra).
 *  Token-gated so it can be run for maintenance; the same operation as the People-screen button. */
router.post('/api/ad-agent/match-identities', async (_req, res) => {
  const out = await syncIdentitiesFromM365('agent-token');
  res.status(out.ok ? 200 : 400).json(out);
});

/** Review-request targets: which offices have a Google review link mapped + active (reporting). */
router.get('/api/ad-agent/review-targets', (_req, res) => {
  try { res.json({ ok: true, offices: discoverReviewOffices() }); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Map an office to a Google review link (token-gated write). Body: { office_id, office_name?, link, phone? }. */
router.post('/api/ad-agent/review-target', (req, res) => {
  const b = req.body || {};
  const officeId = String(b.office_id || '').trim();
  const link = String(b.link || '').trim();
  if (!officeId || !link) return res.status(400).json({ ok: false, error: 'office_id and link are required' });
  try {
    const t = setReviewTarget(officeId, b.office_name != null ? String(b.office_name) : null, link, b.phone != null ? String(b.phone) : null);
    res.json({ ok: true, target: t });
  } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
});

/** Read or set the review send mode ('hold' | 'auto'). GET returns current; POST { mode } sets it. */
router.get('/api/ad-agent/review-mode', (_req, res) => { res.json({ ok: true, mode: getReviewMode() }); });
router.post('/api/ad-agent/review-mode', (req, res) => {
  const mode = String((req.body || {}).mode || '').trim();
  if (mode !== 'hold' && mode !== 'auto') return res.status(400).json({ ok: false, error: "mode must be 'hold' or 'auto'" });
  setReviewMode(mode);
  res.json({ ok: true, mode: getReviewMode() });
});

/** Google Business Profile diagnostic: connection state + how many reviews are stored (reporting). */
router.get('/api/ad-agent/google-status', (_req, res) => {
  try {
    const db = getDb();
    const info = googleConnInfo();
    const reviews = (db.prepare(`SELECT COUNT(*) AS c FROM reviews WHERE source='google'`).get() as { c: number }).c;
    const locations = (db.prepare(`SELECT COUNT(DISTINCT location) AS c FROM reviews WHERE source='google' AND location IS NOT NULL`).get() as { c: number }).c;
    const last = (db.prepare(`SELECT MAX(received_at) AS m FROM reviews WHERE source='google'`).get() as { m: string | null }).m;
    res.json({ ok: true, ...info, reviewsStored: reviews, locations, latestReviewAt: last });
  } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Decode the Graph app-only token's `roles` claim to see exactly which application permissions are
 *  granted (so we know if the app can write group membership / SharePoint permissions). Read-only. */
router.get('/api/ad-agent/graph-perms', async (_req, res) => {
  try {
    const { graphToken } = await import('../services/licenseSources');
    const tok = await graphToken();
    if (!tok) return res.json({ ok: false, error: 'no Graph token (not configured)' });
    const parts = String(tok).split('.');
    if (parts.length < 2) return res.json({ ok: false, error: 'unexpected token format' });
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    res.json({ ok: true, roles: payload.roles || [], appId: payload.appid || payload.azp || null, tenant: payload.tid || null });
  } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Direct-share audit for one SharePoint site (token-gated test): files/folders shared to a person
 *  or via a link, outside the SG-SP groups. ?site=https://host/sites/Name&max=NNN */
router.get('/api/ad-agent/sp-direct-shares', async (req, res) => {
  const site = String(req.query.site || '').slice(0, 300);
  if (!site) return res.status(400).json({ ok: false, error: 'site required' });
  const max = parseInt(String(req.query.max || ''), 10);
  const caps = Number.isFinite(max) && max > 0 ? { maxFolders: max, maxPermChecks: max } : undefined;
  try { res.json(await spDirectShares(site, caps)); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Token-gated background-scan controls (for testing the full-coverage walk). */
router.post('/api/ad-agent/sp-scan/start', (req, res) => {
  const site = String((req.body || {}).site || '').trim();
  if (!site) return res.status(400).json({ ok: false, error: 'site required' });
  res.json({ ok: true, ...startScan(site) });
});
router.get('/api/ad-agent/sp-scan/:id(\\d+)', (req, res) => {
  const row = getScan(Number(req.params.id));
  if (!row) return res.status(404).json({ ok: false, error: 'scan not found' });
  const { result, ...rest } = row;
  res.json({ ok: true, scan: { ...rest, summary: result ? result.summary : null, coverage: result ? result.coverage : row.progress } });
});

/** SharePoint access audit: SG-SP-* groups + members joined to title/office, with drift flags. */
router.get('/api/ad-agent/sp-access-audit', async (req, res) => {
  const prefix = String(req.query.prefix || 'SG-SP-').slice(0, 64);
  try { res.json(await spAccessAudit(prefix)); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Open onboarding requests (id, name, office, whether bound to a BambooHR employee). Reporting read. */
router.get('/api/ad-agent/onboarding-requests', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT r.id, r.name, r.job_position, r.employee_id, r.status, r.created_at,
              e.office AS employee_office, e.department AS employee_department
         FROM onboarding_requests r
         LEFT JOIN employees e ON e.id = r.employee_id
        WHERE r.status NOT IN ('discarded') ORDER BY r.id DESC LIMIT 50`
    ).all();
    res.json({ ok: true, requests: rows });
  } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Dry-run the AD provisioning plan for one onboarding request (read-only, no job enqueued): resolved
 *  OU, UPN, the BambooHR attributes that will be written, security groups, and any warnings. */
router.get('/api/ad-agent/provision-plan', (req, res) => {
  const id = parseInt(String(req.query.id || ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id required' });
  try { res.json({ ok: true, plan: buildProvisionPlan(id) }); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Google probe: surface what the Business Profile API returns (accounts + locations + raw errors)
 *  so a "0 locations" sync can be diagnosed (wrong account vs. API access vs. no listings). */
router.get('/api/ad-agent/google-probe', async (_req, res) => {
  try {
    const token = await googleAccessToken();
    if (!token) return res.json({ ok: false, error: 'no access token (not connected or refresh failed)' });
    const accts = await googleListAccounts(token);
    const out: any = { ok: true, accounts: accts };
    if (accts.ok && accts.accounts.length) {
      out.locationsByAccount = [];
      for (const a of accts.accounts) {
        // eslint-disable-next-line no-await-in-loop
        const locs = await googleListLocations(token, a.name);
        out.locationsByAccount.push({ account: a.name, accountName: a.accountName, ok: locs.ok, error: locs.error, count: locs.ok ? locs.locations.length : 0, titles: locs.ok ? locs.locations.map((l) => l.title).slice(0, 30) : [] });
      }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Re-render queued review requests so older jobs use the follow-up wording. Token-gated. */
router.post('/api/ad-agent/review-rerender', (_req, res) => {
  try { res.json({ ok: true, ...rerenderQueued() }); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Release all held review requests to 'approved' so the scheduled auto-drain sends them at the
 *  daily cap. Token-gated mutation; returns how many were promoted. */
router.post('/api/ad-agent/review-approve-held', (_req, res) => {
  try {
    const db = getDb();
    const info = db.prepare(`UPDATE review_requests SET status='approved' WHERE source='servicetrade' AND status='held'`).run();
    res.json({ ok: true, promoted: info.changes });
  } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Review queue counts by status + daily drain (reporting), to explain the held/approved backlog. */
router.get('/api/ad-agent/review-queue-stats', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT status, COUNT(*) AS c FROM review_requests WHERE source='servicetrade' GROUP BY status`).all() as { status: string; c: number }[];
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = r.c;
    res.json({ ok: true, byStatus, mode: getReviewMode() });
  } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Before/after reputation + request-volume report (reporting read). ?days=N window. */
router.get('/api/ad-agent/review-impact', (req, res) => {
  const days = parseInt(String(req.query.days || '90'), 10);
  try { res.json(reviewImpactReport(Number.isFinite(days) ? days : 90)); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Active-employee roster for reporting: name, position, office, work email only (standard directory
 *  fields, no pay/personal contact). Token-gated. */
router.get('/api/ad-agent/roster', (_req, res) => {
  res.json({ ok: true, ...activeRoster() });
});

/** Current headcount by BambooHR office, as counts and percentages of the company. Token-gated so it
 *  can be read for reporting; returns no PII, only office labels and counts. */
router.get('/api/ad-agent/headcount', (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(office), ''), '(no office set)') AS office, COUNT(*) AS c
       FROM employees WHERE employment_status NOT IN ('terminated', 'prehire')
      GROUP BY office ORDER BY c DESC`
  ).all() as { office: string; c: number }[];
  const total = rows.reduce((s, r) => s + r.c, 0);
  res.json({ ok: true, total, offices: rows.map((r) => ({ office: r.office, count: r.c, pct: total ? Math.round((r.c / total) * 1000) / 10 : 0 })) });
});

/** Mirror counts, so the agent (or an operator with the token) can verify what the last post stored:
 *  how many users, group memberships and OUs the server currently holds, plus the last-sync record. */
router.get('/api/ad-agent/mirror', (_req, res) => {
  const db = getDb();
  const c = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  res.json({ ok: true, users: c('ad_users'), groupMemberships: c('ad_user_groups'), ous: c('ad_ous'), lastSync: lastSync() });
});

/** Receive a full AD snapshot from the DC agent and replace the mirror. Read-only on AD's side. */
router.post('/api/ad-agent/inventory', (req, res) => {
  const b = req.body || {};
  const users: AdUserIn[] = Array.isArray(b.users) ? b.users : [];
  if (!users.length) return res.status(400).json({ ok: false, error: 'no users in payload' });
  try {
    const ous = Array.isArray(b.ous) ? b.ous : undefined;
    const out = ingestInventory(users, typeof b.collectedAt === 'string' ? b.collectedAt : undefined, ous);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/** The DC agent claims pending write jobs to execute (create user, etc.). Marks them claimed so the
 *  same job is not handed out twice; stale claims are returned to the queue automatically. */
router.get('/api/ad-agent/jobs', (_req, res) => {
  res.json({ ok: true, jobs: claimPending() });
});

/** The DC agent reports the result of a job it ran. Success applies the job's side effects. */
router.post('/api/ad-agent/jobs/:id(\\d+)/result', (req, res) => {
  const b = req.body || {};
  const out = completeJob(Number(req.params.id), { ok: !!b.ok, result: b.result, error: b.error });
  res.status(out.ok ? 200 : 404).json(out);
});

/** The audit dashboard read: mirror stats, OU tree, and drift findings. Behind the normal user gate. */
router.get('/api/ad-audit', (_req, res) => {
  res.json({ ok: true, ...auditReport() });
});

/** Whether the agent token is set, so the UI can tell the admin if the DC agent can connect yet. */
router.get('/api/ad-audit/status', (_req, res) => {
  res.json({ ok: true, agentConfigured: !!agentToken() });
});

/** Security groups (by name prefix) with their members, from Entra via Graph. Powers the SharePoint
 *  access reconciliation: the folder audit shows which group grants a folder, not who is in it. */
router.get('/api/ad-audit/sp-groups', async (req, res) => {
  const prefix = String(req.query.prefix || 'SG-SP-').slice(0, 64);
  const out = await listGroupsWithMembers(prefix);
  res.status(out.ok ? 200 : 400).json(out);
});

/** Location group vs BambooHR home office: flags anyone in a location group that is not their office. */
router.get('/api/ad-audit/office-drift', async (req, res) => {
  const prefix = String(req.query.prefix || 'SG-SP-').slice(0, 64);
  const out = await computeOfficeDrift(prefix);
  res.status(out.ok ? 200 : 400).json(out);
});

/** Generate a pilot on-prem group script for one location group, seeded from the cleaned home-office
 *  list (members whose Bamboo office matches; drift + disabled dropped). Suffixed to avoid collision. */
router.get('/api/ad-audit/pilot-script', async (req, res) => {
  const group = String(req.query.group || '').slice(0, 128);
  const suffix = String(req.query.suffix || '-AD').slice(0, 16);
  const out = await buildPilotGroupScript(group, suffix);
  res.status(out.ok ? 200 : 400).json(out);
});

/* ─────────── SharePoint access governance (session-gated: audit + in-app removal) ─────────── */

/** The full SharePoint access audit (groups × members × title/office, with drift flags). */
router.get('/api/ad-audit/sp-access', async (req, res) => {
  const prefix = String(req.query.prefix || 'SG-SP-').slice(0, 64);
  const out = await spAccessAudit(prefix);
  res.status(out.ok ? 200 : 400).json(out);
});

/** Start a full-coverage background direct-share scan for a site. Body: { site }. Returns { id }. */
router.post('/api/ad-audit/sp-scan/start', (req, res) => {
  const site = String((req.body || {}).site || '').trim();
  if (!site) return res.status(400).json({ ok: false, error: 'site required' });
  try { res.json({ ok: true, ...startScan(site) }); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

/** Poll a background scan by id: status + live progress, and the full result once done. */
router.get('/api/ad-audit/sp-scan/:id(\\d+)', (req, res) => {
  const row = getScan(Number(req.params.id));
  if (!row) return res.status(404).json({ ok: false, error: 'scan not found' });
  res.json({ ok: true, scan: row });
});

/** The most recent completed scan for a site (to show on load). ?site=... */
router.get('/api/ad-audit/sp-scan-latest', (req, res) => {
  const site = String(req.query.site || '').trim();
  if (!site) return res.status(400).json({ ok: false, error: 'site required' });
  res.json({ ok: true, scan: latestScan(site) });
});

/** Direct-share audit for one site (session-gated, for the SharePoint access screen). */
router.get('/api/ad-audit/sp-direct-shares', async (req, res) => {
  const site = String(req.query.site || '').slice(0, 300);
  if (!site) return res.status(400).json({ ok: false, error: 'site required' });
  const max = parseInt(String(req.query.max || ''), 10);
  const caps = Number.isFinite(max) && max > 0 ? { maxFolders: max, maxPermChecks: max } : undefined;
  const out = await spDirectShares(site, caps);
  res.status(out.ok ? 200 : 400).json(out);
});

/** Revoke one direct-share permission on a SharePoint item. Body: { driveId, itemId, permId }. */
router.post('/api/ad-audit/sp-unshare', async (req, res) => {
  const b = req.body || {};
  const driveId = String(b.driveId || '').trim();
  const itemId = String(b.itemId || '').trim();
  const permId = String(b.permId || '').trim();
  if (!driveId || !itemId || !permId) return res.status(400).json({ ok: false, error: 'driveId, itemId and permId are required' });
  const out = await removeSharePermission(driveId, itemId, permId);
  res.status(out.ok ? 200 : 400).json(out);
});

/** Remove one person from one SharePoint (SG-SP) group. Body: { group, upn }. */
router.post('/api/ad-audit/sp-remove', async (req, res) => {
  const b = req.body || {};
  const group = String(b.group || '').trim();
  const upn = String(b.upn || '').trim();
  if (!group || !upn) return res.status(400).json({ ok: false, error: 'group and upn are required' });
  const out = await removeUserFromGroup(upn, { groupName: group });
  res.status(out.ok ? 200 : 400).json(out);
});

/** Remove every flagged membership (disabled / not-in-Bamboo / not-active) across all SG-SP groups.
 *  Recomputes the audit fresh so it acts on current state; returns a per-removal result. */
router.post('/api/ad-audit/sp-remove-flagged', async (_req, res) => {
  const audit = await spAccessAudit();
  if (!audit.ok) return res.status(400).json(audit);
  const targets = flaggedRemovals(audit);
  let removed = 0; const failures: { group: string; name: string | null; error?: string }[] = [];
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    const out = await removeUserFromGroup(t.upn, { groupName: t.group });
    if (out.ok) removed++; else failures.push({ group: t.group, name: t.name, error: out.error });
  }
  res.json({ ok: true, attempted: targets.length, removed, failed: failures.length, failures: failures.slice(0, 25) });
});

export default router;
