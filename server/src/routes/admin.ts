import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/index';
import { setState } from '../db/schema';
import { resetDb } from '../db/reset';
import { integrationConnected } from '../config/integrations';

const router = Router();

/**
 * Optional shared-secret gate for admin endpoints. Off by default so the demo
 * "just works"; set ADMIN_TOKEN to require it via `?token=` or `x-admin-token`.
 * Returns true if the request is allowed to proceed.
 */
function adminAuthed(req: import('express').Request): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true; // no token configured → open (demo mode)
  return req.query.token === token || req.get('x-admin-token') === token;
}

/**
 * Reset the demo database — wipe all data and re-seed the sample dataset.
 *
 * Guard rails, because this is destructive:
 *  - Requires an explicit `{ "confirm": "reset" }` body so it can't fire by accident.
 *  - Refuses if ServiceTrade (the real system of record for invoices/jobs) is
 *    connected — that's the signal this instance may hold real data, not demo data.
 *    Set ALLOW_DEMO_RESET=1 to override intentionally.
 */
router.post('/api/admin/reset-demo', (req, res) => {
  if (!adminAuthed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (req.body?.confirm !== 'reset') {
    return res.status(400).json({
      ok: false,
      error: 'confirmation required',
      hint: 'POST { "confirm": "reset" } to wipe and re-seed the demo database.',
    });
  }

  const override = process.env.ALLOW_DEMO_RESET === '1';
  if (integrationConnected('servicetrade') && !override) {
    return res.status(409).json({
      ok: false,
      error: 'refusing to reset: ServiceTrade is connected (this may be live data)',
      hint: 'Set ALLOW_DEMO_RESET=1 to override.',
    });
  }

  const result = resetDb();
  console.log(`[admin] demo DB reset — ${result.cleared} rows cleared, re-seeded.`);
  return res.json({ ok: true, ...result });
});

/**
 * Download a consistent snapshot of the live SQLite database — no SSH needed.
 *
 * Uses SQLite's online backup API (better-sqlite3 `db.backup`) instead of copying
 * the raw file, so the snapshot folds in any pending WAL writes and is never torn,
 * even while the app is serving. Streams the copy as an attachment, then deletes it.
 *
 * Open by default (demo data). Set ADMIN_TOKEN to require `?token=` / `x-admin-token`.
 *   curl -fL "https://<APP>.fly.dev/api/admin/backup" -o 1stfp.db
 */
router.get('/api/admin/backup', async (req, res) => {
  if (!adminAuthed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-07-12T17-13-10
  const filename = `1stfp-${stamp}.db`;
  const tmp = path.join(os.tmpdir(), `backup-${stamp}-${process.pid}.db`);
  const cleanup = () => fs.promises.unlink(tmp).catch(() => {});

  try {
    await getDb().backup(tmp); // consistent snapshot including WAL
    setState('last_backup_at', new Date().toISOString()); // surfaced via /api/introspect health
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

export default router;
