import { Router } from 'express';
import { handleEndOfCall } from '../services/receptionist';
import { telephonyEnabled } from '../config/voice';

const router = Router();

/**
 * Telephony webhook. WIRED now, GATED off until a voice provider key is present.
 * Handles the provider's end-of-call-report: logs the call + extracts a lead.
 * When VAPI_API_KEY / TWILIO_* arrive, it goes live with no code change.
 */
router.post('/api/webhooks/call', async (req, res) => {
  const body = req.body || {};

  // Normalize a Vapi-style end-of-call-report (also accepts a flat shape).
  const msg = body.message || body;
  const report = {
    from_number: msg.customer?.number || msg.from_number || body.from,
    duration: msg.durationSeconds || msg.duration,
    transcript:
      msg.transcript ||
      (Array.isArray(msg.messages)
        ? msg.messages.map((m: any) => `${m.role}: ${m.message || m.content || ''}`).join('\n')
        : ''),
    intent: msg.analysis?.structuredData?.intent || msg.analysis?.intent || msg.intent,
    outcome: msg.analysis?.structuredData?.outcome || (msg.endedReason ? 'message' : msg.outcome),
    started_at: msg.startedAt || msg.started_at,
    vapi_id: msg.call?.id || msg.callId || msg.id || body.call?.id,
  };

  // Graceful degradation: without a voice key we still accept + log the payload,
  // but mark it as a demo capture so nothing external is assumed live.
  const result = await handleEndOfCall(report);
  res.json({ ok: true, ...result });
});

export default router;
