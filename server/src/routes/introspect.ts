import { Router } from 'express';
import crypto from 'crypto';
import { buildIntrospectionSnapshot } from '../services/introspection';

const router = Router();

/**
 * GET /api/introspect — capability & usage metadata for Booker Growth OS.
 *
 * Auth: `Authorization: Bearer <INTROSPECT_TOKEN>`. With no INTROSPECT_TOKEN configured
 * the endpoint is 503 — it can never be reached unauthenticated by accident. The payload
 * is metadata only (see services/introspection.ts for the hard boundary).
 */

/** Constant-time comparison — hash both sides so length never leaks. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

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

export default router;
