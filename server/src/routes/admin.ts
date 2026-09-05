import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/index';
import { setState } from '../db/schema';
import { resetDb } from '../db/reset';
import { integrationConnected } from '../config/integrations';
import { requireOs, actorOf } from '../os/authz';
import { P } from '../os/policy';
import { osAudit } from '../os/audit';
import { timingSafeEqualStr } from '../os/security';
import { runOffFlyBackup, offFlyConfigured } from '../services/backupExport';

const router = Router();
const liveMode = (): boolean => process.env.DEMO_MODE === 'off';

/**
 * Admin-secret gate for the destructive/export endpoints. Layered ON TOP of requireOs(P.admin), which
 * already requires a mapped identity + Access:2 in hybrid/enforce. This gate additionally:
 *  - FAILS CLOSED in production (live mode) when ADMIN_TOKEN is not configured, so a shared-password
 *    session can never download the database or reset it. Returns a machine-readable 503.
 *  - Requires a matching ADMIN_TOKEN (timing-safe) via `x-admin-token` header or `?token=` when set.
 *  - Stays open only in actual demo mode with no token, for local convenience.
 */
export function adminSecretGuard(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    if (liveMode()) {
      res.status(503).json({ ok: false, error: 'admin_not_configured', hint: 'Set the ADMIN_TOKEN Fly secret to enable admin endpoints in production.' });
      return;
    }
    return next(); // demo mode, no token: local convenience only
  }
  const got = String(req.get('x-admin-token') || req.query.token || '');
  if (!got || !timingSafeEqualStr(got, token)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  next();
}

/**
 * Reset the demo database - wipe all data and re-seed the sample dataset. Guard rails:
 *  - identity + Access:2 (requireOs) and the admin secret (adminSecretGuard);
 *  - refuses when live (DEMO_MODE=off) unless ALLOW_DEMO_RESET=1, and refuses when ServiceTrade is
 *    connected (a signal this instance may hold real data);
 *  - requires an explicit { confirm: 'reset' } body.
 */
router.post('/api/admin/reset-demo', requireOs(P.admin), adminSecretGuard, (req, res) => {
  if (req.body?.confirm !== 'reset') {
    return res.status(400).json({ ok: false, error: 'confirmation required', hint: 'POST { "confirm": "reset" } to wipe and re-seed the demo database.' });
  }
  const override = process.env.ALLOW_DEMO_RESET === '1';
  if (liveMode() && !override) {
    return res.status(409).json({ ok: false, error: 'refusing to reset in live mode', hint: 'Set ALLOW_DEMO_RESET=1 to override (destructive).' });
  }
  if (integrationConnected('servicetrade') && !override) {
    return res.status(409).json({ ok: false, error: 'refusing to reset: ServiceTrade is connected (this may be live data)', hint: 'Set ALLOW_DEMO_RESET=1 to override.' });
  }
  const result = resetDb();
  const who = actorOf(req);
  osAudit({ actor: who.label, actor_email: who.email, module: 'access', action: 'admin.reset_demo', new_summary: `${result.cleared} rows cleared` });
  console.log(`[admin] demo DB reset by ${who.label} - ${result.cleared} rows cleared, re-seeded.`);
  return res.json({ ok: true, ...result });
});

/**
 * Download a consistent snapshot of the SQLite database via the online backup API (folds in WAL, never
 * torn). Requires identity + Access:2 + the admin secret; fails closed in production without ADMIN_TOKEN.
 */
router.get('/api/admin/backup', requireOs(P.admin), adminSecretGuard, async (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `1stfp-os-backup-${stamp}.db`;
  const tmp = path.join(os.tmpdir(), `backup-${stamp}-${process.pid}.db`);
  const cleanup = () => fs.promises.unlink(tmp).catch(() => {});
  try {
    await getDb().backup(tmp);
    setState('last_backup_at', new Date().toISOString());
    const who = actorOf(req);
    osAudit({ actor: who.label, actor_email: who.email, module: 'access', action: 'admin.backup', new_summary: 'database snapshot downloaded' });
    res.download(tmp, filename, (err) => {
      void cleanup();
      if (err && !res.headersSent) console.warn('[admin] backup send error:', err.message);
    });
  } catch (err) {
    await cleanup();
    console.warn('[admin] backup failed:', (err as Error).message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * Trigger an encrypted off-Fly backup export. No-op ("not_configured") unless BACKUP_UPLOAD_URL and
 * BACKUP_ENCRYPTION_KEY are both set. Never exposes the destination or the key.
 */
router.post('/api/admin/backup/offsite', requireOs(P.admin), adminSecretGuard, async (req, res) => {
  if (!offFlyConfigured()) return res.status(400).json({ ok: false, error: 'not_configured', hint: 'Set BACKUP_UPLOAD_URL and BACKUP_ENCRYPTION_KEY to enable off-Fly backups.' });
  const out = await runOffFlyBackup();
  const who = actorOf(req);
  osAudit({ actor: who.label, actor_email: who.email, module: 'access', action: 'admin.backup_offsite', new_summary: out.ok ? `${out.bytes} bytes uploaded` : `failed: ${out.error || out.skipped}` });
  res.status(out.ok ? 200 : 500).json(out);
});

export default router;
