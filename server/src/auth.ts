import express from 'express';
import crypto from 'crypto';

/**
 * Simple shared-password gate for the whole app.
 *
 * Active ONLY when APP_PASSWORD is set (as a Fly secret). With no password configured the gate
 * is disabled so a fresh deploy can never lock everyone out before the secret exists. A correct
 * password sets a signed, HttpOnly session cookie (30 days); the signing key is derived from the
 * password itself, so rotating the password invalidates old sessions. No new dependencies.
 */

const COOKIE = 'fpos_auth';
const TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

function appPassword(): string | null {
  const p = process.env.APP_PASSWORD;
  return p && p.length > 0 ? p : null;
}

/** The gate only enforces when a password is configured. */
export function authRequired(): boolean {
  return appPassword() != null;
}

function signingSecret(): string {
  return crypto.createHash('sha256').update('fpos-session|' + (appPassword() || '')).digest('hex');
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
  return verifySession(readCookie(req, COOKIE));
}

/** Constant-time password compare (hash both to a fixed length so length never leaks). */
function passwordMatches(given: string, actual: string): boolean {
  const g = crypto.createHash('sha256').update(given).digest();
  const a = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(g, a);
}

// Paths reachable without a session: the login flow, the Fly health check, and the two inbound
// webhooks external services POST to (they carry no cookie).
const OPEN = new Set(['/login', '/api/login', '/api/logout', '/api/health', '/api/servicetrade/webhook', '/api/webhooks/call']);
function isAsset(p: string): boolean {
  return /\.(css|js|mjs|map|woff2?|ttf|otf|png|jpe?g|gif|svg|ico|webp|mp3|wav)$/i.test(p) || p.startsWith('/brand/');
}

/** Middleware: allow assets + open paths; else require a valid session (401 for API, redirect for pages). */
export function gate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!authRequired()) return next();
  const p = req.path;
  if (OPEN.has(p) || isAsset(p) || isAuthed(req)) return next();
  if (p.startsWith('/api/')) {
    res.status(401).json({ ok: false, error: 'auth required' });
    return;
  }
  res.redirect('/login');
}

export function handleLogin(req: express.Request, res: express.Response): void {
  const pw = appPassword();
  if (!pw) {
    res.json({ ok: true }); // gate disabled
    return;
  }
  const given = String(req.body?.password ?? '');
  if (given.length > 0 && passwordMatches(given, pw)) {
    res.setHeader('Set-Cookie', `${COOKIE}=${signSession()}; HttpOnly; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}; SameSite=Lax; Secure`);
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ ok: false, error: 'Incorrect password' });
}

export function handleLogout(_req: express.Request, res: express.Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`);
  res.json({ ok: true });
}
