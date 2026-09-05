import { getDb } from '../db/index';
import { OsContext } from './scope';

/**
 * Immutable OS action-audit trail. One append-only helper for every sensitive operating action:
 * quote create/edit/delete, price-book and margin changes, quote status changes, takeoff generation,
 * approval decisions, and external sends. Rows are never updated or deleted by application code.
 *
 * The actor is ALWAYS the authenticated identity resolved server-side, never a client-supplied label.
 * old/new summaries are short human-readable strings; callers must never pass secrets, tokens, or raw
 * request/response bodies.
 */

export interface OsAuditEntry {
  actor: string;              // resolved display name or email, or 'system'
  actor_email?: string | null;
  office?: string | null;
  module?: string | null;
  action: string;             // dotted verb, e.g. 'quote.create'
  subject_type?: string | null;
  subject_id?: string | number | null;
  correlation_id?: string | null;
  old_summary?: string | null;
  new_summary?: string | null;
  detail?: string | null;
}

/** The authenticated actor for a context: a mapped identity, else 'legacy-shared' / 'system'. Never client-supplied. */
export function actorLabel(ctx: OsContext | null | undefined): string {
  if (ctx?.user) return ctx.user.display_name || ctx.user.email;
  if (ctx?.legacy) return 'legacy-shared';
  return 'system';
}

/** Append one immutable audit row. Best-effort: never throws into the caller's write path. */
export function osAudit(e: OsAuditEntry): void {
  try {
    getDb().prepare(
      `INSERT INTO os_audit (actor, actor_email, office, module, action, subject_type, subject_id, correlation_id, old_summary, new_summary, detail)
       VALUES (@actor, @actor_email, @office, @module, @action, @subject_type, @subject_id, @correlation_id, @old_summary, @new_summary, @detail)`
    ).run({
      actor: e.actor || 'system',
      actor_email: e.actor_email ?? null,
      office: e.office ?? null,
      module: e.module ?? null,
      action: e.action,
      subject_type: e.subject_type ?? null,
      subject_id: e.subject_id != null ? String(e.subject_id) : null,
      correlation_id: e.correlation_id ?? null,
      old_summary: e.old_summary ?? null,
      new_summary: e.new_summary ?? null,
      detail: e.detail ?? null,
    });
  } catch { /* audit must never break the underlying action */ }
}

/** Convenience: audit from a request context (pulls actor + office). */
export function auditFromCtx(ctx: OsContext, action: string, opts: Partial<OsAuditEntry> = {}): void {
  osAudit({
    actor: actorLabel(ctx),
    actor_email: ctx.user?.email ?? null,
    office: opts.office ?? null,
    action,
    ...opts,
  });
}

export interface OsAuditRow extends OsAuditEntry { id: number; at: string; }

/** Read recent audit rows (newest first), optionally filtered by subject or action prefix. */
export function listAudit(opts: { subject_type?: string; subject_id?: string | number; action?: string; limit?: number } = {}): OsAuditRow[] {
  const where: string[] = []; const args: any = {};
  if (opts.subject_type) { where.push('subject_type = @st'); args.st = opts.subject_type; }
  if (opts.subject_id != null) { where.push('subject_id = @sid'); args.sid = String(opts.subject_id); }
  if (opts.action) { where.push('action LIKE @act'); args.act = opts.action + '%'; }
  const sql = `SELECT * FROM os_audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Math.min(Number(opts.limit) || 100, 1000)}`;
  return getDb().prepare(sql).all(args) as OsAuditRow[];
}
