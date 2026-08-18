/**
 * OS-wide request context + office-scope authorization.
 *
 * The security model the spec requires is:
 *   identity → permissions → office scope → server query → authorized data
 * NOT "load everything, hide unauthorized rows in JavaScript."
 *
 * `currentContext(req)` resolves who is asking and which offices they may see. Scoped endpoints then:
 *   1. resolve the requested office against the caller's allowed scope (`resolveOffice`), and
 *   2. build an in-SQL filter (`officeScopeClause`) that uses the `os_office_key()` UDF so only
 *      authorized rows are ever returned by the database.
 *
 * Legacy access is preserved: a session authenticated only by the shared APP_PASSWORD (no Entra
 * identity, no app_users row) is treated as company-wide *unless* OS_REQUIRE_IDENTITY=1. This lets
 * the migration off the shared password happen without breaking today's access. People routes keep
 * their own stricter Entra gate (requirePeople) untouched.
 */
import express from 'express';
import { AppUser, currentUser } from '../people/authz';
import { canonicalOffice, officeLabel, isNonOffice } from './office';
import { getDb } from '../db/index';

export interface OsContext {
  user: AppUser | null;   // the mapped app user, when signed in with an authorized identity
  email: string | null;
  roles: string[];
  allOffices: boolean;    // may this caller see every office?
  offices: string[];      // canonical office keys in scope (empty when allOffices)
  legacy: boolean;        // true = shared-password session with no OS identity
}

function requireIdentity(): boolean {
  return process.env.OS_REQUIRE_IDENTITY === '1';
}

/** Resolve the caller's OS context (identity + office scope). Never throws. */
export function currentContext(req: express.Request): OsContext {
  const user = currentUser(req);
  if (user) {
    return {
      user,
      email: user.email,
      roles: user.roles,
      allOffices: user.all_offices,
      offices: user.offices,
      legacy: false,
    };
  }
  // No OS identity. Under the default (migration) posture, a shared-password session keeps
  // company-wide access; when OS_REQUIRE_IDENTITY=1 it has NO office scope at all.
  const legacyWide = !requireIdentity();
  return { user: null, email: null, roles: [], allOffices: legacyWide, offices: [], legacy: true };
}

/** True when the caller is authorized for the given canonical office key. */
export function canSeeOffice(ctx: OsContext, officeKey: string): boolean {
  if (ctx.allOffices) return true;
  return ctx.offices.includes(officeKey);
}

/** The offices this caller may choose from, as {key,label}. Company-wide callers get everything the
 *  data actually contains (discovered from the mirror) plus the curated known set. */
export function allowedOffices(ctx: OsContext): Array<{ key: string; label: string }> {
  if (ctx.allOffices) return discoverOffices();
  return ctx.offices
    .map((key) => ({ key, label: officeLabel(key) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Resolve a requested office (from a query param / header) against the caller's scope.
 * Returns { office: 'all' } for a company-wide request by an authorized caller, or a specific
 * canonical key, or { error } when the caller may not see what they asked for.
 */
export function resolveOffice(ctx: OsContext, requested: string | null | undefined): { office: string } | { error: string; status: number } {
  const raw = (requested || '').trim().toLowerCase();

  // "all" / empty → company-wide when allowed; otherwise fall back to the caller's single office,
  // and reject only when a scoped caller explicitly demands "all".
  if (!raw || raw === 'all') {
    if (ctx.allOffices) return { office: 'all' };
    if (ctx.offices.length === 1) return { office: ctx.offices[0] };
    if (ctx.offices.length === 0) return { error: 'no_office_scope', status: 403 };
    return { office: '__scoped__' }; // multi-office scoped caller viewing all THEIR offices
  }

  // A specific office was requested. It may be a raw name or a canonical key; normalize either way.
  const key = canonicalOffice(raw) || raw;
  if (!canSeeOffice(ctx, key)) return { error: 'office_forbidden', status: 403 };
  return { office: key };
}

/**
 * Build a parameterized WHERE fragment that restricts `<column>` to the caller's authorized offices,
 * optionally narrowed to a single resolved office. Always enforced in SQL via os_office_key().
 *
 * @param column   the SQL column holding the office string (e.g. "office", "office_name")
 * @param ctx      the caller context
 * @param resolved the output of resolveOffice(): 'all', a specific key, or '__scoped__'
 */
export function officeScopeClause(column: string, ctx: OsContext, resolved: string): { sql: string; params: any[] } {
  const key = `os_office_key(${column})`;

  // A specific office was selected (and already authorized by resolveOffice).
  if (resolved && resolved !== 'all' && resolved !== '__scoped__') {
    return { sql: `${key} = ?`, params: [resolved] };
  }

  // Company-wide view.
  if (resolved === 'all') {
    if (ctx.allOffices) return { sql: '1=1', params: [] };
    // A non-company caller can never widen to all; restrict to their set (defensive).
    return inList(key, ctx.offices);
  }

  // '__scoped__': all of a multi-office caller's offices.
  if (ctx.allOffices) return { sql: '1=1', params: [] };
  return inList(key, ctx.offices);
}

function inList(keyExpr: string, offices: string[]): { sql: string; params: any[] } {
  if (!offices.length) return { sql: '1=0', params: [] }; // no scope → no rows (never leak)
  const placeholders = offices.map(() => '?').join(',');
  return { sql: `${keyExpr} IN (${placeholders})`, params: [...offices] };
}

/** Discover the offices actually present in the mirror, canonicalized + de-duped, with labels.
 *  Each source is read independently so a missing/renamed table never zeroes the whole result. */
export function discoverOffices(): Array<{ key: string; label: string }> {
  const db = getDb();
  const sources: string[] = [
    `SELECT DISTINCT office AS o FROM sched_appointments WHERE office IS NOT NULL AND office != ''`,
    `SELECT DISTINCT office_name AS o FROM crm_jobs WHERE office_name IS NOT NULL AND office_name != ''`,
    `SELECT DISTINCT office AS o FROM quotes WHERE source='servicetrade' AND office IS NOT NULL AND office != ''`,
    `SELECT DISTINCT office AS o FROM deficiencies WHERE office IS NOT NULL AND office != ''`,
    `SELECT DISTINCT office AS o FROM employees WHERE office IS NOT NULL AND office != ''`,
  ];
  const byKey = new Map<string, string>();
  for (const sql of sources) {
    let rows: { o: string }[] = [];
    try {
      rows = db.prepare(sql).all() as { o: string }[];
    } catch {
      rows = []; // table not present in this DB — skip this source
    }
    for (const r of rows) {
      if (isNonOffice(r.o)) continue;
      const key = canonicalOffice(r.o);
      if (key && !byKey.has(key)) byKey.set(key, officeLabel(key));
    }
  }
  return [...byKey.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
}
