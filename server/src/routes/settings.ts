import { Router } from 'express';
import {
  stConfigured,
  stCredKind,
  getStMode,
  setStMode,
  testConnection,
  listWebhooks,
  registerWebhook,
  deleteWebhook,
  ServiceTradeReadOnlyError,
  ServiceTradeNotConnectedError,
  type StMode,
} from '../services/servicetrade';
import { startPull, pullStatus } from '../services/servicetradeSync';
import { getDb } from '../db/index';

/** Map a ServiceTrade client error to a clean HTTP response. */
function stError(res: import('express').Response, err: unknown) {
  if (err instanceof ServiceTradeReadOnlyError) return res.status(409).json({ ok: false, error: err.message, code: 'read_only' });
  if (err instanceof ServiceTradeNotConnectedError) return res.status(409).json({ ok: false, error: err.message, code: 'not_connected' });
  return res.status(502).json({ ok: false, error: (err as Error).message });
}

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

// ── webhook subscriptions on ServiceTrade (list = read; register/delete = write, mode-gated) ──

router.get('/api/settings/servicetrade/webhooks', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await listWebhooks()) });
  } catch (err) {
    stError(res, err);
  }
});

router.post('/api/settings/servicetrade/webhooks', async (req, res) => {
  // Default the hook URL to THIS app's receiver, carrying the shared secret if one is set.
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const secret = process.env.SERVICETRADE_WEBHOOK_SECRET;
  const defaultUrl = `${base}/api/servicetrade/webhook${secret ? `?token=${encodeURIComponent(secret)}` : ''}`;
  const hookUrl = String(req.body?.hookUrl || defaultUrl);
  const entityEvents = Array.isArray(req.body?.entityEvents) ? req.body.entityEvents : null;
  try {
    res.json({ ok: true, webhook: await registerWebhook(hookUrl, entityEvents) });
  } catch (err) {
    stError(res, err); // read-only mode → 409 read_only
  }
});

router.delete('/api/settings/servicetrade/webhooks/:id', async (req, res) => {
  try {
    await deleteWebhook(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    stError(res, err);
  }
});

// ── pull real records FROM ServiceTrade (GET-only; safe in read-only) ──
// Pulls run in the background (locations paginate into hundreds of pages); the client polls
// /pull/status. Credentials/connection are still required — startPull's work will surface a
// not-connected error via the status if creds are missing.
router.post('/api/settings/servicetrade/pull/:entity', (req, res) => {
  const entity = req.params.entity;
  if (entity !== 'accounts' && entity !== 'sites' && entity !== 'invoices') {
    return res.status(400).json({ ok: false, error: 'unknown entity' });
  }
  if (!stConfigured()) return res.status(409).json({ ok: false, error: 'ServiceTrade is not connected', code: 'not_connected' });
  const r = startPull(entity);
  if (!r.started) return res.status(409).json({ ok: false, error: `a ${r.entity} pull is already running`, code: 'busy' });
  res.json({ ok: true, started: true, entity });
});

router.get('/api/settings/servicetrade/pull/status', (_req, res) => {
  res.json({ ok: true, status: pullStatus() });
});

export default router;
