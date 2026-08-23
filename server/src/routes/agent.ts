import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { ingestInventory, auditReport, AdUserIn } from '../services/adAudit';
import { claimPending, completeJob } from '../services/dcJobs';
import { listGroupsWithMembers } from '../services/msGraphGroups';
import { computeOfficeDrift } from '../services/groupOfficeDrift';

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

/** Receive a full AD snapshot from the DC agent and replace the mirror. Read-only on AD's side. */
router.post('/api/ad-agent/inventory', (req, res) => {
  const b = req.body || {};
  const users: AdUserIn[] = Array.isArray(b.users) ? b.users : [];
  if (!users.length) return res.status(400).json({ ok: false, error: 'no users in payload' });
  try {
    const out = ingestInventory(users, typeof b.collectedAt === 'string' ? b.collectedAt : undefined);
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

export default router;
