import { getDb } from '../db/index';
import { spDirectShares } from './spDirectShares';

/**
 * Background full-coverage direct-share scans. A full walk of a large SharePoint site takes minutes
 * and far exceeds one HTTP request, so a scan is a job row in sp_scans: start returns immediately,
 * the walk runs in the background updating progress, and the screen polls the row until it is done.
 *
 * The walk holds results in memory and persists them on completion, so a finished scan survives a
 * restart; an in-flight scan does not (its row is reaped as stale on the next read).
 */

// Effectively uncapped for a full-coverage scan (still a backstop against a pathological tree).
const FULL_CAPS = { maxFolders: 20000, maxPermChecks: 100000 };
const STALE_MS = 20 * 60 * 1000; // a running row older than this with no progress is treated as dead

export interface ScanRow {
  id: number; site: string; status: string; started_at: string; finished_at: string | null;
  progress: any | null; result: any | null; error: string | null;
}

function parse(s: string | null): any { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

/** Start a background scan for a site. Returns the new scan id immediately. */
export function startScan(site: string): { id: number } {
  const db = getDb();
  const info = db.prepare(`INSERT INTO sp_scans (site, status, progress_json) VALUES (?, 'running', ?)`)
    .run(site, JSON.stringify({ foldersScanned: 0, itemsSeen: 0, sharedItems: 0 }));
  const id = Number(info.lastInsertRowid);

  // Fire-and-forget: run the walk without blocking the request.
  void (async () => {
    let lastWrite = 0;
    try {
      const out = await spDirectShares(site, FULL_CAPS, new Date().toISOString(), (cov) => {
        const now = Date.now();
        if (now - lastWrite < 1500) return; // throttle DB writes
        lastWrite = now;
        try { getDb().prepare(`UPDATE sp_scans SET progress_json = ? WHERE id = ?`).run(JSON.stringify(cov), id); } catch { /* ignore */ }
      });
      if (out.ok) {
        getDb().prepare(`UPDATE sp_scans SET status='done', finished_at=datetime('now'), result_json=?, progress_json=? WHERE id=?`)
          .run(JSON.stringify(out), JSON.stringify(out.coverage), id);
      } else {
        getDb().prepare(`UPDATE sp_scans SET status='error', finished_at=datetime('now'), error=? WHERE id=?`).run(out.error, id);
      }
    } catch (e) {
      try { getDb().prepare(`UPDATE sp_scans SET status='error', finished_at=datetime('now'), error=? WHERE id=?`).run((e as Error).message, id); } catch { /* ignore */ }
    }
  })();

  return { id };
}

/** One scan's current state. Marks an abandoned 'running' row (no update past the stale window) as error. */
export function getScan(id: number): ScanRow | null {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM sp_scans WHERE id = ?`).get(id) as any;
  if (!r) return null;
  if (r.status === 'running') {
    const started = Date.parse(r.started_at + 'Z') || Date.now();
    if (Date.now() - started > STALE_MS) {
      db.prepare(`UPDATE sp_scans SET status='error', error='scan interrupted (server restarted)' WHERE id=? AND status='running'`).run(id);
      r.status = 'error'; r.error = 'scan interrupted (server restarted)';
    }
  }
  return { id: r.id, site: r.site, status: r.status, started_at: r.started_at, finished_at: r.finished_at, progress: parse(r.progress_json), result: parse(r.result_json), error: r.error };
}

/** The most recent completed scan for a site (to show on load without rescanning). */
export function latestScan(site: string): ScanRow | null {
  const db = getDb();
  const r = db.prepare(`SELECT id FROM sp_scans WHERE site = ? AND status = 'done' ORDER BY id DESC LIMIT 1`).get(site) as { id: number } | undefined;
  return r ? getScan(r.id) : null;
}
