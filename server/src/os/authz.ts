import express from 'express';
import crypto from 'crypto';
import { currentContext, resolveOffice, OsContext } from './scope';
import { moduleLevel, Level } from '../people/permissions';

/**
 * The OS authorization layer: one reusable, server-enforced boundary for every protected route.
 *
 * Rollout is controlled by OS_AUTH_MODE (default 'hybrid'):
 *   legacy  - preserve today's shared-password behavior everywhere (compatibility escape hatch);
 *             readiness surfaces a warning that identity is not enforced.
 *   hybrid  - low-risk reads still work for a shared-password session, but any SENSITIVE action
 *             (writes, sends, deletes) requires a mapped Entra identity + role authorization + scope.
 *   enforce - every protected page and API requires a mapped Entra identity.
 *
 * The middleware (requireOs) enforces the decision; the pure decide() function carries the logic so it
 * is unit-testable without HTTP. Office scope is resolved separately against the caller's allowed
 * offices (resolveReqOffice / scopeOrFail) so a client-supplied office is never trusted as authority.
 */

export type AuthMode = 'legacy' | 'hybrid' | 'enforce';

export function osAuthMode(): AuthMode {
  const m = String(process.env.OS_AUTH_MODE || 'hybrid').trim().toLowerCase();
  return m === 'legacy' || m === 'enforce' ? m : 'hybrid';
}

export interface Policy {
  /** Access matrix module governing this route (e.g. 'deficiencies', 'pricing', 'access'). */
  module?: string;
  /** Minimum level required on that module for a mapped user. Defaults to 1 (view). */
  level?: Level;
  /** True for writes / sends / deletes: needs an identity in hybrid mode, not just a shared session. */
  sensitive?: boolean;
}

export type Decision = { allow: true } | { allow: false; status: number; error: string };

/**
 * The pure authorization decision. Never touches Express so it can be tested directly.
 * mode 'legacy' allows any gated session. Otherwise identity is required when the mode enforces it
 * (always in 'enforce', or for sensitive actions in 'hybrid'), then the module level is checked.
 */
export function decide(mode: AuthMode, ctx: OsContext, policy: Policy): Decision {
  if (mode === 'legacy') return { allow: true };

  const needIdentity = mode === 'enforce' || !!policy.sensitive;
  if (needIdentity && !ctx.user) {
    return { allow: false, status: 401, error: 'identity_required' };
  }
  if (policy.module && ctx.user) {
    const need = (policy.level ?? 1) as Level;
    if (moduleLevel(ctx.user, policy.module) < need) {
      return { allow: false, status: 403, error: 'forbidden' };
    }
  }
  return { allow: true };
}

/** Express middleware enforcing a policy. Attaches the resolved OsContext at req.osctx on success. */
export function requireOs(policy: Policy) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const ctx = currentContext(req);
    const d = decide(osAuthMode(), ctx, policy);
    if (!d.allow) {
      res.status(d.status).json({
        ok: false,
        error: d.error,
        need: policy.module ? { module: policy.module, level: policy.level ?? 1 } : undefined,
        mode: osAuthMode(),
      });
      return;
    }
    (req as any).osctx = ctx;
    next();
  };
}

/** The OsContext for a request (cached by requireOs, else resolved fresh). */
export function ctxOf(req: express.Request): OsContext {
  return (req as any).osctx || currentContext(req);
}

/**
 * Resolve the office a request is asking for against the caller's authorized scope. NEVER trusts the
 * raw client office as authority: it is validated against ctx via resolveOffice.
 * Returns { office } (a canonical key, 'all', or '__scoped__') or an { error, status } to send.
 */
export function resolveReqOffice(req: express.Request): { office: string } | { error: string; status: number } {
  const ctx = ctxOf(req);
  const requested = String((req.query.office ?? (req.body && req.body.office) ?? '') || '');
  return resolveOffice(ctx, requested);
}

/**
 * Resolve the request office or send a 403 office_forbidden and return null. Use in a route:
 *   const office = scopeOrFail(req, res); if (office === null) return;
 */
export function scopeOrFail(req: express.Request, res: express.Response): string | null {
  const r = resolveReqOffice(req);
  if ('error' in r) { res.status(r.status).json({ ok: false, error: r.error }); return null; }
  return r.office;
}

/**
 * The set of office keys a READ request is authorized to see, or 'ALL' for a company-wide caller.
 * Sends a 403 and returns null when the requested office is outside the caller's scope.
 *   const scope = officeKeysOrFail(req, res); if (scope === null) return;
 *   const keys = scope === 'ALL' ? null : scope;   // null = no office filter
 */
export function officeKeysOrFail(req: express.Request, res: express.Response): string[] | 'ALL' | null {
  const ctx = ctxOf(req);
  const r = resolveReqOffice(req);
  if ('error' in r) { res.status(r.status).json({ ok: false, error: r.error }); return null; }
  if (r.office === 'all') return 'ALL';
  if (r.office === '__scoped__') return ctx.offices;
  return [r.office];
}

/**
 * The single concrete office a WRITE must target, validated against the caller's scope. A company-wide
 * or multi-office caller must name one office (400 office_required); an out-of-scope office is 403.
 */
export function writeOfficeOrFail(req: express.Request, res: express.Response): string | null {
  const r = resolveReqOffice(req);
  if ('error' in r) { res.status(r.status).json({ ok: false, error: r.error }); return null; }
  if (r.office === 'all' || r.office === '__scoped__') {
    res.status(400).json({ ok: false, error: 'office_required', hint: 'Pick a specific office for this action.' });
    return null;
  }
  return r.office;
}

/**
 * The office for a price-book / margins operation. The shared catalog is office '' and a company-wide
 * caller may manage it; a scoped caller with one office defaults to that office; a multi-office caller
 * must name one. A specific office must be in scope. Sends 400/403 and returns null on failure.
 */
export function pricingOfficeOrFail(req: express.Request, res: express.Response): string | null {
  const ctx = ctxOf(req);
  const raw = String((req.query.office ?? (req.body && req.body.office) ?? '') || '').trim().toLowerCase();
  if (!raw || raw === 'all') {
    if (ctx.allOffices) return '';           // the shared catalog
    if (ctx.offices.length === 1) return ctx.offices[0];
    res.status(400).json({ ok: false, error: 'office_required', hint: 'Pick a specific office for the price book.' });
    return null;
  }
  const { canonicalOffice } = require('./office') as typeof import('./office');
  const key = canonicalOffice(raw) || raw;
  if (!canActOnOffice(req, key)) { res.status(403).json({ ok: false, error: 'office_forbidden' }); return null; }
  return key;
}

/** True when the caller may act on a specific canonical office key (for object-by-id scope checks). */
export function canActOnOffice(req: express.Request, officeKey: string): boolean {
  const ctx = ctxOf(req);
  if (ctx.allOffices) return true;
  return ctx.offices.includes(String(officeKey || '').toLowerCase());
}

/** The authenticated actor for audit stamping: a real identity, else a truthful system label. */
export function actorOf(req: express.Request): { label: string; email: string | null } {
  const ctx = ctxOf(req);
  if (ctx.user) return { label: ctx.user.display_name || ctx.user.email, email: ctx.user.email };
  if (ctx.legacy) return { label: 'legacy-shared', email: null };
  return { label: 'system', email: null };
}

/** A short correlation id for tying an audit entry to a request/outbox action. */
export function correlationId(): string {
  return crypto.randomBytes(8).toString('hex');
}
