import { getDb } from '../db/index';
import { applyCreateUserResult } from './onboardingAgent';

/**
 * DC agent job queue.
 *
 * The OS enqueues write actions; the domain-controller agent pulls pending jobs (claimPending),
 * runs them against AD, and posts each result back (completeJob). Outbound-only: the DC polls, so
 * nothing reaches into it. When a job completes, its side effects are applied here by kind, e.g. an
 * ad_create_user job marks the onboarding items done and stamps the hire's AD identity.
 */

const STALE_MINUTES = 10; // a claimed job not finished within this is returned to the queue

export type DcJobKind = 'ad_create_user';

export interface EnqueueRef { type: string; id: number }

export function enqueue(kind: DcJobKind, payload: unknown, ref: EnqueueRef | null, by: string): { id: number } {
  const db = getDb();
  const info = db
    .prepare(`INSERT INTO dc_jobs (kind, payload_json, ref_type, ref_id, requested_by) VALUES (?,?,?,?,?)`)
    .run(kind, JSON.stringify(payload || {}), ref ? ref.type : null, ref ? ref.id : null, by || 'operator');
  return { id: Number(info.lastInsertRowid) };
}

/** Claim the pending jobs for an agent run. Reclaims stale claims first, then hands out (and marks
 *  claimed) up to `limit` jobs in one transaction so a job is never handed out twice. */
export function claimPending(limit = 25): { id: number; kind: string; payload: any }[] {
  const db = getDb();
  const claim = db.transaction((n: number) => {
    db.prepare(`UPDATE dc_jobs SET status = 'pending' WHERE status = 'claimed' AND claimed_at < datetime('now', ?)`).run(`-${STALE_MINUTES} minutes`);
    const rows = db.prepare(`SELECT id, kind, payload_json FROM dc_jobs WHERE status = 'pending' ORDER BY id ASC LIMIT ?`).all(n) as { id: number; kind: string; payload_json: string }[];
    const mark = db.prepare(`UPDATE dc_jobs SET status = 'claimed', claimed_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`);
    for (const r of rows) mark.run(r.id);
    return rows;
  });
  const rows = claim(limit);
  return rows.map((r) => ({ id: r.id, kind: r.kind, payload: safeParse(r.payload_json) }));
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

/** Record an agent's result for a job and run its side effects. Idempotent: a job already finished
 *  is left alone. */
export function completeJob(id: number, outcome: { ok: boolean; result?: any; error?: string }): { ok: boolean; error?: string } {
  const db = getDb();
  const job = db.prepare(`SELECT * FROM dc_jobs WHERE id = ?`).get(id) as any;
  if (!job) return { ok: false, error: 'job not found' };
  if (job.status === 'done' || job.status === 'cancelled') return { ok: true }; // already settled

  if (outcome.ok) {
    db.prepare(`UPDATE dc_jobs SET status = 'done', result_json = ?, error = NULL, finished_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(outcome.result || {}), id);
    dispatchSideEffects(job, outcome.result || {});
  } else {
    db.prepare(`UPDATE dc_jobs SET status = 'error', error = ?, result_json = ?, finished_at = datetime('now') WHERE id = ?`)
      .run(String(outcome.error || 'unknown error'), JSON.stringify(outcome.result || {}), id);
  }
  return { ok: true };
}

function dispatchSideEffects(job: any, result: any): void {
  if (job.kind === 'ad_create_user' && job.ref_type === 'onboarding_request' && job.ref_id) {
    applyCreateUserResult(Number(job.ref_id), {
      sam: result.sam,
      upn: result.upn,
      objectGuid: result.objectGuid,
      groupsAdded: result.groupsAdded,
    });
  }
}

/* ─────────────────────────── reads (for the UI) ─────────────────────────── */
export function listJobsForRef(refType: string, refId: number): any[] {
  return getDb().prepare(`SELECT id, kind, status, error, result_json, created_at, finished_at FROM dc_jobs WHERE ref_type = ? AND ref_id = ? ORDER BY id DESC`).all(refType, refId);
}
export function latestJobForRef(refType: string, refId: number): any | null {
  return (getDb().prepare(`SELECT * FROM dc_jobs WHERE ref_type = ? AND ref_id = ? ORDER BY id DESC LIMIT 1`).get(refType, refId) as any) || null;
}
export function jobStats(): { pending: number; claimed: number; error: number } {
  const db = getDb();
  const g = (s: string) => (db.prepare(`SELECT COUNT(*) AS c FROM dc_jobs WHERE status = ?`).get(s) as { c: number }).c;
  return { pending: g('pending'), claimed: g('claimed'), error: g('error') };
}
