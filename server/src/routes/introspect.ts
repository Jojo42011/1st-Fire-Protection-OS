import { Router } from 'express';
import crypto from 'crypto';
import { buildIntrospectionSnapshot } from '../services/introspection';
import { getDb } from '../db';
import { ensurePlatformSchema } from '../platform/schema';

const router = Router();

/** Constant-time comparison — hash both sides so length never leaks. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * GET /api/introspect — capability & usage metadata.
 * Auth: Authorization: Bearer <INTROSPECT_TOKEN>.
 */
router.get('/api/introspect', (req, res) => {
  const expected = process.env.INTROSPECT_TOKEN;
  if (!expected) {
    return res
      .status(503)
      .json({ ok: false, error: 'introspection disabled: INTROSPECT_TOKEN is not configured' });
  }

  const header = req.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
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
router.post('/api/platform/events', (req, res) => {
  const expected = process.env.SYSTEMIZE_EVENT_TOKEN;
  if (!expected) return res.status(503).json({ ok: false, error: 'event intake disabled' });

  const header = req.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
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
  const existing = db.prepare('SELECT event_id FROM platform_events WHERE event_id = ?').get(eventId);
  if (existing) return res.json({ ok: true, duplicate: true, event_id: eventId });

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

  return res.status(202).json({ ok: true, duplicate: false, event_id: eventId });
});

export default router;
