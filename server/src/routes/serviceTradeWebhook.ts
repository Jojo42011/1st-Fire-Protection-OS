import { Router } from 'express';
import { ingestServiceTradeInvoice } from '../services/serviceTrade';
import { serviceTradeEnabled } from '../config/comms';

const router = Router();

/**
 * ServiceTrade webhook. WIRED now; arms the reminder workflow the moment a job is completed
 * and its invoice is created.
 *
 * We care about the events that produce a billable, completed job:
 *   invoice.created / invoice.updated / job.completed
 * Every other event type is acked 200 so ServiceTrade doesn't retry.
 *
 * Security: if SERVICETRADE_WEBHOOK_SECRET is set, the `x-st-secret` header must match.
 * Without the env var we accept anything (demo-friendly) but log a one-time warning.
 */

let warnedNoSecret = false;

const RELEVANT = /invoice|job\.completed|completed/i;

router.post('/api/webhooks/servicetrade', (req, res) => {
  const secret = process.env.SERVICETRADE_WEBHOOK_SECRET;
  if (secret) {
    const got = req.header('x-st-secret') || req.header('x-servicetrade-secret');
    if (got !== secret) return res.status(401).json({ ok: false, error: 'invalid webhook secret' });
  } else if (!warnedNoSecret) {
    warnedNoSecret = true;
    console.warn('[serviceTradeWebhook] SERVICETRADE_WEBHOOK_SECRET not set — accepting unauthenticated webhooks.');
  }

  const body = req.body || {};
  const type = body.type || body.event || body.action || 'invoice';

  if (!RELEVANT.test(String(type))) {
    return res.json({ ok: true, ignored: type });
  }

  try {
    const result = ingestServiceTradeInvoice(body);
    if (result.scheduled > 0) {
      console.log(`[serviceTrade] invoice ${result.invoiceId}: armed ${result.scheduled} reminder step(s)`);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    // Never 500 a provider webhook into a retry storm — log and ack.
    console.warn('[serviceTradeWebhook] ingest failed:', (err as Error).message);
    res.json({ ok: false, error: (err as Error).message, live: serviceTradeEnabled() });
  }
});

export default router;
