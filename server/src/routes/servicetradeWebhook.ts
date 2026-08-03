import { Router } from 'express';
import { getDb } from '../db/index';
import { nudgeSync } from '../services/servicetradeSync';

/**
 * ServiceTrade webhook receiver — the endpoint ServiceTrade PUSHES events to (job completed,
 * invoice created, quote updated…) over its NATIVE webhook API. No Zapier in the middle.
 *
 * Security: ServiceTrade webhooks carry no HMAC signature, so we protect the endpoint with a
 * shared secret in the URL/header (SERVICETRADE_WEBHOOK_SECRET). ServiceTrade "confirms" a new
 * subscription by the endpoint responding 200 (and echoing any challenge token), which we do.
 *
 * This is READ-SIDE: it only records events. It never writes back to ServiceTrade, so it's
 * fully compatible with read-only mode. Routing events to agents (which then draft, gated)
 * is the next layer.
 */
const router = Router();

function secretOk(req: any): boolean {
  const want = process.env.SERVICETRADE_WEBHOOK_SECRET;
  if (!want) return true; // no secret configured → accept (dev / not yet locked down)
  const got = req.query?.token || req.headers['x-webhook-token'];
  return got === want;
}

router.post('/api/servicetrade/webhook', (req, res) => {
  if (!secretOk(req)) return res.status(401).json({ ok: false, error: 'bad or missing webhook token' });

  const body = (req.body || {}) as Record<string, any>;

  // Subscription confirmation handshake: echo any challenge/confirmation token ServiceTrade sends.
  const challenge = body.challenge || body.confirmation || req.query?.challenge || req.query?.confirmation;
  if (challenge) return res.status(200).send(String(challenge));

  // Best-effort field extraction across the notification shapes; the raw body is always kept.
  const action = body.action || body.event || null;
  const entityType = body.entityType || body.entity_type || body.type || null;
  const entityId = body.entityId ?? body.entity_id ?? body.id ?? null;

  try {
    getDb()
      .prepare(
        `INSERT INTO servicetrade_events (action, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?)`
      )
      .run(action ? String(action) : null, entityType ? String(entityType) : null, entityId != null ? String(entityId) : null, JSON.stringify(body).slice(0, 20000));
    getDb()
      .prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', ?, 'applied', ?)`)
      .run(`ServiceTrade event: ${action || 'notification'} ${entityType || ''}`.trim(), entityType ? String(entityType) : null);
  } catch {
    /* never let recording failure bounce a webhook — ServiceTrade would just retry */
  }
  nudgeSync(); // coalesce this + any burst into one incremental sync ~30s out
  res.status(200).json({ ok: true });
});

/** Inspect the most recent events ServiceTrade has pushed us. */
router.get('/api/servicetrade/webhook/events', (_req, res) => {
  const rows = getDb()
    .prepare(`SELECT id, action, entity_type, entity_id, processed, received_at FROM servicetrade_events ORDER BY id DESC LIMIT 50`)
    .all();
  res.json({ events: rows, count: rows.length });
});

export default router;
