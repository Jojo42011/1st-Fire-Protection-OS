import { Router } from 'express';
import { stConfigured, stCredKind, getStMode, setStMode, testConnection, type StMode } from '../services/servicetrade';
import { getDb } from '../db/index';

/**
 * Settings — the ServiceTrade connection status + the read-only/write safety toggle.
 * The mode is persisted (system_state) and defaults to read_only. Flipping to write is the
 * only thing that lets the app change real ServiceTrade data, and it's logged.
 */
const router = Router();

router.get('/api/settings/servicetrade', (_req, res) => {
  res.json({
    connected: stConfigured(),
    credKind: stCredKind(), // 'token' | 'password' | 'none' — never the secret itself
    mode: getStMode(),
    canWrite: getStMode() === 'read_write',
  });
});

router.post('/api/settings/servicetrade/mode', (req, res) => {
  const requested = String(req.body?.mode || '');
  if (requested !== 'read_only' && requested !== 'read_write') {
    return res.status(400).json({ ok: false, error: "mode must be 'read_only' or 'read_write'" });
  }
  const mode = setStMode(requested as StMode);
  // audit trail: every mode change is logged to the sync log so there's a record of when writes
  // were enabled (and by whom, once auth exists).
  try {
    getDb()
      .prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('out', ?, 'applied', NULL)`)
      .run(mode === 'read_write' ? 'Write mode ENABLED — the app can now change ServiceTrade' : 'Switched to read-only — ServiceTrade is protected');
  } catch {
    /* sync_log is best-effort */
  }
  res.json({ ok: true, mode, canWrite: mode === 'read_write' });
});

router.post('/api/settings/servicetrade/test', async (_req, res) => {
  const result = await testConnection();
  res.json({ ...result, connected: stConfigured(), mode: getStMode() });
});

export default router;
