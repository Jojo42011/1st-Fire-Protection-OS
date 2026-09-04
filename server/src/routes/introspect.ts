import { Router } from 'express';
import crypto from 'crypto';
import { buildIntrospectionSnapshot } from '../services/introspection';
import { getDb } from '../db';
import { ensurePlatformSchema } from '../platform/schema';
import { dispatchPendingEvents, startEventDispatcher } from '../platform/eventDispatcher';

const router = Router();
startEventDispatcher();

/** Constant-time comparison — hash both sides so length never leaks. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearer(req: { get(name: string): string | undefined }): string {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

/** GET /api/introspect — capability & usage metadata. */
router.get('/api/introspect', (req, res) => {
  const expected = process.env.INTROSPECT_TOKEN;
  if (!expected) {
    return res
      .status(503)
      .json({ ok: false, error: 'introspection disabled: INTROSPECT_TOKEN is not configured' });
  }
  const presented = bearer(req);
  if (!presented || !tokenMatches(presented, expected)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    return res.json(buildIntrospectionSnapshot());
  } catch (err) {
    console.warn('[introspect] snapshot failed:', (err as Error).message);
    return res.status(500).json({ ok: false, error: 'snapshot failed' });
  }
});

/**
 * POST /api/platform/events — canonical event intake for trusted Systemize surfaces.
 * Duplicate event IDs are accepted idempotently and never create duplicate downstream intent.
 */
router.post('/api/platform/events', async (req, res) => {
  const expected = process.env.SYSTEMIZE_EVENT_TOKEN;
  if (!expected) return res.status(503).json({ ok: false, error: 'event intake disabled' });

  const presented = bearer(req);
  if (!presented || !tokenMatches(presented, expected)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const body = req.body as Record<string, unknown>;
  const eventId = String(body.event_id || '').trim();
  const eventType = String(body.event_type || '').trim();
  const clientId = String(body.client_id || '1stfp').trim();
  const source = String(body.source || '').trim();
  const correlationId = String(body.correlation_id || eventId).trim();
  const schemaVersion = String(body.schema_version || '1').trim();

  if (!eventId || !eventType || !source || !correlationId) {
    return res.status(422).json({ ok: false, error: 'event_id, event_type, source, and correlation_id are required' });
  }

  ensurePlatformSchema();
  const db = getDb();
  const existing = db.prepare('SELECT event_id, status FROM platform_events WHERE event_id = ?').get(eventId) as { event_id: string; status: string } | undefined;
  if (existing) return res.json({ ok: true, duplicate: true, event_id: eventId, status: existing.status });

  db.prepare(`
    INSERT INTO platform_events
      (event_id, event_type, client_id, source, correlation_id, schema_version, actor_json, payload_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    eventId,
    eventType,
    clientId,
    source,
    correlationId,
    schemaVersion,
    body.actor === undefined ? null : JSON.stringify(body.actor),
    body.payload === undefined ? null : JSON.stringify(body.payload),
    body.occurred_at ? String(body.occurred_at) : null,
  );

  // Attempt the durable handoff immediately. If Inngest is down, the local
  // event remains queued and the background dispatcher retries with backoff.
  void dispatchPendingEvents();
  return res.status(202).json({ ok: true, duplicate: false, event_id: eventId, status: 'received' });
});

/** Machine/operator view of the owned platform ledger. */
router.get('/api/platform/status', (req, res) => {
  const expected = process.env.SYSTEMIZE_EVENT_TOKEN;
  if (!expected) return res.status(503).json({ ok: false, error: 'platform API disabled' });
  const presented = bearer(req);
  if (!presented || !tokenMatches(presented, expected)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  ensurePlatformSchema();
  const db = getDb();
  const eventCounts = db.prepare(`SELECT status, COUNT(*) AS count FROM platform_events GROUP BY status`).all();
  const runCounts = db.prepare(`SELECT status, COUNT(*) AS count FROM workflow_runs GROUP BY status`).all();
  const recentRuns = db.prepare(`
    SELECT id, workflow_key, workflow_version, correlation_id, status, started_at, completed_at, error
    FROM workflow_runs ORDER BY started_at DESC LIMIT 25
  `).all();
  const recentActions = db.prepare(`
    SELECT id, correlation_id, workflow_run_id, agent_key, tool_key, action_key, risk_level, status, created_at
    FROM agent_actions ORDER BY created_at DESC LIMIT 50
  `).all();
  const recentResources = db.prepare(`
    SELECT id, system, resource_type, external_id, idempotency_key, workflow_run_id, status, created_at
    FROM external_resources ORDER BY created_at DESC LIMIT 50
  `).all();

  return res.json({
    ok: true,
    runtime: {
      inngest: !!process.env.INNGEST_EVENT_KEY,
      relevance: !!(process.env.RELEVANCE_API_URL && process.env.RELEVANCE_API_KEY),
      openrouter: !!(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL),
      langfuse: !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
    },
    eventCounts,
    runCounts,
    recentRuns,
    recentActions,
    recentResources,
  });
});

export default router;
