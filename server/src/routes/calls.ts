import { Router } from 'express';
import { getDb } from '../db/index';
import { getCallMetrics, syncFromVapi } from '../services/receptionist';
import { telephonyEnabled } from '../config/voice';

const router = Router();

/** Parse the JSON-stringified columns back into objects for the client. */
function hydrate(row: any): any {
  const parse = (v: unknown) => {
    if (typeof v !== 'string' || !v) return v ?? null;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  return {
    ...row,
    messages: parse(row.messages),
    cost_breakdown: parse(row.cost_breakdown),
    structured_data: parse(row.structured_data),
  };
}

router.get('/api/calls', (_req, res) => {
  const db = getDb();
  const calls = (db.prepare(`SELECT * FROM calls ORDER BY started_at DESC`).all() as any[]).map(hydrate);
  const leads = db.prepare(`SELECT * FROM leads ORDER BY created_at DESC`).all();
  res.json({
    metrics: getCallMetrics(),
    calls,
    leads,
    live: telephonyEnabled(),
  });
});

/** Backfill recent calls from Vapi's REST API (uses VAPI_API_KEY). Graceful no-op without a key. */
router.post('/api/calls/sync', async (req, res) => {
  const limit = Number(req.body?.limit) || 100;
  const result = await syncFromVapi(limit);
  res.json({ ok: !result.error, ...result });
});

/** Update a lead's status (in-house / reversible). */
router.post('/api/calls/leads/:id/status', (req, res) => {
  const status = String(req.body?.status || 'new');
  getDb().prepare(`UPDATE leads SET status = ? WHERE id = ?`).run(status, Number(req.params.id));
  res.json({ ok: true, status });
});

export default router;
