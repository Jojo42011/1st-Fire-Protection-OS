import { Router } from 'express';
import { getDb } from '../db/index';
import { getCallMetrics } from '../services/receptionist';
import { telephonyEnabled } from '../config/voice';
import { vapiEnabled, syncVapiCalls } from '../services/vapi';

const router = Router();

router.get('/api/calls', (_req, res) => {
  const db = getDb();
  const calls = db.prepare(`SELECT * FROM calls ORDER BY started_at DESC`).all();
  const leads = db.prepare(`SELECT * FROM leads ORDER BY created_at DESC`).all();
  res.json({
    metrics: getCallMetrics(),
    calls,
    leads,
    live: telephonyEnabled(),
    vapi: vapiEnabled(),
  });
});

/** Pull the latest calls from Vapi into the dashboard (tracking). No-op without a key. */
router.post('/api/calls/sync', async (_req, res) => {
  try {
    const result = await syncVapiCalls();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/** Update a lead's status (in-house / reversible). */
router.post('/api/calls/leads/:id/status', (req, res) => {
  const status = String(req.body?.status || 'new');
  getDb().prepare(`UPDATE leads SET status = ? WHERE id = ?`).run(status, Number(req.params.id));
  res.json({ ok: true, status });
});

export default router;
