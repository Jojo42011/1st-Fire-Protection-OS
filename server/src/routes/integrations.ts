import { Router } from 'express';
import { resolveIntegrations } from '../config/integrations';
import { AGENTS } from '../config/agents';
import { listSchedules, setSchedule, runSyncNow } from '../services/syncScheduler';

const router = Router();

/** The per-integration sync cadence, for the schedule settings panel. */
router.get('/api/sync-schedules', (_req, res) => {
  res.json({ ok: true, schedules: listSchedules() });
});

/** Update one integration's cadence (interval_minutes and/or enabled). */
router.put('/api/sync-schedules/:key', (req, res) => {
  const body = req.body || {};
  const out = setSchedule(req.params.key, {
    interval_minutes: body.interval_minutes != null ? Number(body.interval_minutes) : undefined,
    enabled: body.enabled != null ? !!body.enabled : undefined,
  });
  if (!out) return res.status(404).json({ ok: false, error: 'unknown_integration' });
  res.json({ ok: true, schedule: out });
});

/** Force-sync one integration now. */
router.post('/api/sync-schedules/:key/run', async (req, res) => {
  const out = await runSyncNow(req.params.key);
  if (!out) return res.status(404).json({ ok: false, error: 'unknown_integration' });
  res.json({ ok: out.ok, status: out.status, detail: out.detail });
});

router.get('/api/integrations', (_req, res) => {
  const integrations = resolveIntegrations();
  // group by category for the catalog view
  const byCategory: Record<string, typeof integrations> = {};
  for (const i of integrations) {
    (byCategory[i.category] ||= []).push(i);
  }
  res.json({
    integrations,
    byCategory,
    team: AGENTS.map((a) => ({
      key: a.key,
      name: a.name,
      role: a.role,
      status: a.status,
      connectVia: a.connectVia || [],
    })),
    counts: {
      connected: integrations.filter((i) => i.status === 'connected').length,
      available: integrations.filter((i) => i.status === 'available').length,
      planned: integrations.filter((i) => i.status === 'planned').length,
    },
  });
});

export default router;
