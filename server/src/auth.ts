import express from 'express';
import crypto from 'crypto';
import { currentIdentity } from './people/identity';

/**
 * Simple shared-password gate for the whole app.
 *
 * Active ONLY when APP_PASSWORD is set (as a Fly secret). With no password configured the gate
 * is disabled so a fresh deploy can never lock everyone out before the secret exists. A correct
 * password sets a signed, HttpOnly session cookie (30 days); the signing key is derived from the
 * password itself, so rotating the password invalidates old sessions. No new dependencies.
 *
 * Break-glass "god mode": signing in with the god password grants a FULL super-admin session (all
 * offices, all modules) without Microsoft sign-in. The password comes from either GOD_MODE_PASSWORD
 * (a Fly secret) or an app-managed password a people_admin sets in Access & Roles (stored only as a
 * scrypt hash). It is off unless one is set, off entirely in demo mode, every use is audited, and
 * readiness flags it as a standing bypass. It does not bypass the separate ADMIN_TOKEN gate on the raw
 * database export/reset endpoints. Use it as a fallback, not daily.
 */

const COOKIE = 'fpos_auth';
const GOD_COOKIE = 'fpos_god';
const TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const GOD_TTL_MS = 12 * 3600 * 1000;  // god-mode sessions are short-lived (12h)

function appPassword(): string | null {
  const p = process.env.APP_PASSWORD;
  return p && p.length > 0 ? p : null;
}

/* ─────────────────────────── god mode credential ───────────────────────────
 * Two sources, either of which enables god mode: the GOD_MODE_PASSWORD Fly secret (env), and an
 * app-managed password a people_admin sets in Access & Roles (stored ONLY as a scrypt hash + salt in
 * the state table, never plaintext). The app-managed one is what lets the password be rotated from the
 * UI without a Fly deploy. God mode is always OFF in demo mode regardless of either source. */
const GOD_MIN_LEN = 12;
function demoOn(): boolean { return process.env.DEMO_MODE !== 'off'; }
function envGodPassword(): string | null {
  const p = process.env.GOD_MODE_PASSWORD;
  return p && p.length >= GOD_MIN_LEN ? p : null;
}
function stateGet(key: string): string | null {
  try { const { getState } = require('./db/schema'); const v = getState(key); return v || null; } catch { return null; }
}
function stateSet(key: string, val: string): void {
  try { const { setState } = require('./db/schema'); setState(key, val); } catch { /* db not ready */ }
}
function dbGodHash(): { hash: string; salt: string } | null {
  const hash = stateGet('god_pw_hash'); const salt = stateGet('god_pw_salt');
  return hash && salt ? { hash, salt } : null;
}
export function godModeConfigured(): boolean {
  if (demoOn()) return false;
  return envGodPassword() != null || dbGodHash() != null;
}

/** Non-secret status for the Access & Roles screen: whether god mode is on, and where it comes from. */
export function godStatus(): { configured: boolean; source: 'env' | 'app' | 'both' | 'none'; app_set: boolean; env_set: boolean; set_by: string | null; set_at: string | null; min_length: number } {
  const env = !demoOn() && envGodPassword() != null;
  const app = !demoOn() && dbGodHash() != null;
  const source = env && app ? 'both' : env ? 'env' : app ? 'app' : 'none';
  return { configured: env || app, source, app_set: app, env_set: env, set_by: stateGet('god_pw_set_by'), set_at: stateGet('god_pw_set_at'), min_length: GOD_MIN_LEN };
}

/** Set (or rotate) the app-managed god password. Stores a scrypt hash only. people_admin gated by the route. */
export function setGodPassword(plain: string, by: string): { ok: boolean; error?: string } {
  if (demoOn()) return { ok: false, error: 'god mode is disabled in demo mode' };
  if (!plain || plain.length < GOD_MIN_LEN) return { ok: false, error: `password must be at least ${GOD_MIN_LEN} characters` };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, Buffer.from(salt, 'hex'), 32).toString('hex');
  stateSet('god_pw_hash', hash); stateSet('god_pw_salt', salt);
  stateSet('god_pw_set_by', by || 'admin'); stateSet('god_pw_set_at', new Date().toISOString());
  return { ok: true };
}
/** Remove the app-managed god password (the env secret, if any, still applies). */
export function clearGodPassword(): void {
  for (const k of ['god_pw_hash', 'god_pw_salt', 'god_pw_set_by', 'god_pw_set_at']) stateSet(k, '');
}
/** Constant-time check of a candidate against either god source. */
function verifyGodPassword(given: string): boolean {
  if (demoOn() || !given) return false;
  const env = envGodPassword();
  if (env && given.length > 0 && passwordMatches(given, env)) return true;
  const db = dbGodHash();
  if (db) {
    try {
      const calc = crypto.scryptSync(given, Buffer.from(db.salt, 'hex'), 32).toString('hex');
      const a = Buffer.from(calc, 'hex'); const b = Buffer.from(db.hash, 'hex');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch { /* bad stored value */ }
  }
  return false;
}

/** The gate only enforces when a password is configured. */
export function authRequired(): boolean {
  return appPassword() != null;
}

function signingSecret(): string {
  return crypto.createHash('sha256').update('fpos-session|' + (appPassword() || '')).digest('hex');
}
function godSecret(): string {
  // Fingerprint both sources so changing (or clearing) either invalidates existing god sessions.
  const db = dbGodHash();
  return crypto.createHash('sha256').update('fpos-god|' + (envGodPassword() || '') + '|' + (db ? db.hash : '')).digest('hex');
}
function signGod(): string {
  const exp = String(Date.now() + GOD_TTL_MS);
  return exp + '.' + crypto.createHmac('sha256', godSecret()).update(exp).digest('hex');
}
/** A valid, unexpired god-mode session cookie. False when god mode is not configured. */
export function isGodMode(req: express.Request): boolean {
  if (!godModeConfigured()) return false;
  const token = readCookie(req, GOD_COOKIE);
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expect = crypto.createHmac('sha256', godSecret()).update(exp).digest('hex');
  try { return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch { return false; }
}

function signSession(): string {
  const exp = String(Date.now() + TTL_MS);
  const sig = crypto.createHmac('sha256', signingSecret()).update(exp).digest('hex');
  return exp + '.' + sig;
}

function verifySession(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expect = crypto.createHmac('sha256', signingSecret()).update(exp).digest('hex');
  try {
    return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  } catch {
    return false;
  }
}

function readCookie(req: express.Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function isAuthed(req: express.Request): boolean {
  // Either the shared-password session, or a verified Microsoft (Entra) identity. Signing in with
  // Microsoft is a full app sign-in: a real person in the tenant, not just the office password.
  return verifySession(readCookie(req, COOKIE)) || !!currentIdentity(req);
}

/** Constant-time password compare (hash both to a fixed length so length never leaks). */
function passwordMatches(given: string, actual: string): boolean {
  const g = crypto.createHash('sha256').update(given).digest();
  const a = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(g, a);
}

// Paths reachable without a session: the login flow, the Fly health check, the two inbound
// webhooks external services POST to (they carry no cookie), and the People Entra sign-in flow.
// People auth has its own security (signed id_token + state + nonce) and MUST be reachable on the
// cross-site OIDC return: that navigation lands in the People iframe, so the SameSite=Lax app
// cookie is withheld and this gate would otherwise 401 the callback before it can run.
const OPEN = new Set([
  '/login',
  '/api/login',
  '/api/logout',
  '/api/health',
  '/api/servicetrade/webhook',
  '/api/webhooks/call',
  '/api/people/auth/login',
  '/api/people/auth/callback',
  '/api/people/me', // read-only auth state (entraConfigured/devLogin/authenticated) for the login page
]);
function isAsset(p: string): boolean {
  return /\.(css|js|mjs|map|woff2?|ttf|otf|png|jpe?g|gif|svg|ico|webp|mp3|wav)$/i.test(p) || p.startsWith('/brand/');
}
// The tokenised intake flow is deliberately public: a hiring manager has no OS account. Security is
// the single-use, expiring token itself, checked in the intake service, not a session cookie.
function isPublicIntake(p: string): boolean {
  return p.startsWith('/intake/') || p.startsWith('/api/intake/');
}
// The on-prem AD agent authenticates with its own bearer token (checked in routes/agent.ts), not an
// app session: the domain controller has no OS login. Let its endpoints past the session gate so the
// token check can run.
function isAgentApi(p: string): boolean {
  return p.startsWith('/api/ad-agent/');
}

/** Middleware: allow assets + open paths; else require a valid session (401 for API, redirect for pages). */
export function gate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!authRequired()) return next();
  const p = req.path;
  if (OPEN.has(p) || isAsset(p) || isPublicIntake(p) || isAgentApi(p) || isAuthed(req)) return next();
  if (p.startsWith('/api/')) {
    res.status(401).json({ ok: false, error: 'auth required' });
    return;
  }
  res.redirect('/login');
}

export function handleLogin(req: express.Request, res: express.Response): void {
  const given = String(req.body?.password ?? '');

  // God mode is checked first: signing in with the god password (env secret OR the app-managed one)
  // grants a full super-admin session (a normal app session cookie PLUS a short-lived god cookie) even
  // when the office password gate is off. Every use is audited so it is never a silent backdoor.
  if (verifyGodPassword(given)) {
    res.setHeader('Set-Cookie', [
      `${COOKIE}=${signSession()}; HttpOnly; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}; SameSite=Lax; Secure`,
      `${GOD_COOKIE}=${signGod()}; HttpOnly; Path=/; Max-Age=${Math.floor(GOD_TTL_MS / 1000)}; SameSite=Lax; Secure`,
    ]);
    try {
      // Lazy require so auth.ts stays free of a static dependency on the audit module.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { osAudit } = require('./os/audit');
      osAudit({ actor: 'god-mode', module: 'access', action: 'auth.god_login', detail: 'full-admin break-glass sign-in' });
    } catch { /* auditing must never block sign-in */ }
    res.json({ ok: true, godMode: true });
    return;
  }

  const pw = appPassword();
  if (!pw) {
    res.json({ ok: true }); // gate disabled
    return;
  }
  if (given.length > 0 && passwordMatches(given, pw)) {
    res.setHeader('Set-Cookie', `${COOKIE}=${signSession()}; HttpOnly; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}; SameSite=Lax; Secure`);
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ ok: false, error: 'Incorrect password' });
}

export function handleLogout(_req: express.Request, res: express.Response): void {
  res.setHeader('Set-Cookie', [
    `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`,
    `${GOD_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`,
  ]);
  res.json({ ok: true });
}
