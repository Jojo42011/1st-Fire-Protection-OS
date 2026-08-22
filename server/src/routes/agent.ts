import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { ingestInventory, auditReport, AdUserIn } from '../services/adAudit';

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

/** The audit dashboard read: mirror stats, OU tree, and drift findings. Behind the normal user gate. */
router.get('/api/ad-audit', (_req, res) => {
  res.json({ ok: true, ...auditReport() });
});

/** Whether the agent token is set, so the UI can tell the admin if the DC agent can connect yet. */
router.get('/api/ad-audit/status', (_req, res) => {
  res.json({ ok: true, agentConfigured: !!agentToken() });
});

export default router;
