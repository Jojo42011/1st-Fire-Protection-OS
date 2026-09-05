import { Router } from 'express';
import { ingestVapiCall } from '../services/receptionist';
import { telephonyEnabled } from '../config/voice';
import { timingSafeEqualStr } from '../os/security';

const router = Router();
const liveMode = (): boolean => process.env.DEMO_MODE === 'off';

/** Pure webhook-auth decision (testable): a set secret must match; in live mode a missing secret rejects. */
export function vapiWebhookAuth(got: string, secret: string | undefined, live: boolean): 'ok' | 'invalid' | 'missing_secret' {
  if (secret) return timingSafeEqualStr(got, secret) ? 'ok' : 'invalid';
  if (live) return 'missing_secret';
  return 'ok';
}

/**
 * Telephony webhook (Vapi Server URL). WIRED now, GATED off until a voice key is present.
 *
 * Vapi POSTs many server messages here; we only persist `end-of-call-report` (the one
 * with the full artifact: transcript, recording, messages, cost, analysis). Every other
 * event type is acked 200 so Vapi doesn't retry.
 *
 * Security: if VAPI_SERVER_SECRET is set, the `x-vapi-secret` header must match. Without
 * the env var we accept anything (demo-friendly) but log a one-time warning.
 */

let warnedNoSecret = false;

router.post('/api/webhooks/call', async (req, res) => {
  // --- verify the shared secret ---
  const decision = vapiWebhookAuth(String(req.header('x-vapi-secret') || ''), process.env.VAPI_SERVER_SECRET, liveMode());
  if (decision === 'invalid') return res.status(401).json({ ok: false, error: 'invalid x-vapi-secret' });
  if (decision === 'missing_secret') {
    if (!warnedNoSecret) { warnedNoSecret = true; console.warn('[callWebhook] READINESS: VAPI_SERVER_SECRET not set in live mode - rejecting unauthenticated webhooks.'); }
    return res.status(401).json({ ok: false, error: 'webhook_secret_required' });
  }
  if (!process.env.VAPI_SERVER_SECRET && !warnedNoSecret) {
    warnedNoSecret = true;
    console.warn('[callWebhook] VAPI_SERVER_SECRET not set (demo mode) - accepting unauthenticated webhooks.');
  }

  const body = req.body || {};
  const msg = body.message || body; // Vapi nests under `message`; also accept a flat shape.
  const type = msg.type || 'end-of-call-report';

  // Only the end-of-call report carries the full artifact. Ack everything else.
  if (type !== 'end-of-call-report') {
    return res.json({ ok: true, ignored: type });
  }

  try {
    const result = await ingestVapiCall(msg);
    res.json({ ok: true, ...result });
  } catch (err) {
    // Never 500 a provider webhook into a retry storm — log and ack.
    console.warn('[callWebhook] ingest failed:', (err as Error).message);
    res.json({ ok: false, error: (err as Error).message, live: telephonyEnabled() });
  }
});

export default router;
