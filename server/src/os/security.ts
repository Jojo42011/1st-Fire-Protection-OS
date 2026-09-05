import express from 'express';
import crypto from 'crypto';

/**
 * Lightweight, dependency-free web hardening: security headers, a same-origin CSRF guard for
 * cookie-authenticated state-changing browser requests, and a small in-memory rate limiter. Kept
 * minimal on purpose (single Fly machine, no new dependency tree) and compatible with the app's
 * same-origin iframe pages and the Entra login redirect.
 */

const liveMode = (): boolean => process.env.DEMO_MODE === 'off';

/** Baseline security response headers. No strict CSP (the app uses inline scripts by design). */
export function securityHeaders(req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // pages render only in the app's own same-origin iframes
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'geolocation=(), payment=()');
  if (liveMode()) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

/** The hosts a browser request may legitimately originate from (this host + the configured public base). */
function allowedHosts(req: express.Request): Set<string> {
  const hosts = new Set<string>();
  const h = String(req.headers.host || '').toLowerCase();
  if (h) hosts.add(h);
  try { if (process.env.PUBLIC_BASE_URL) hosts.add(new URL(process.env.PUBLIC_BASE_URL).host.toLowerCase()); } catch { /* ignore */ }
  return hosts;
}

// Paths exempt from the CSRF origin check: inbound webhooks (no Origin, protected by shared secret),
// the token-authenticated AD agent API, public token intake, and the OIDC login/callback.
function csrfExempt(p: string): boolean {
  return p.startsWith('/api/servicetrade/webhook')
    || p.startsWith('/api/webhooks/')
    || p.startsWith('/api/ad-agent/')
    || p.startsWith('/api/intake/')
    || p.startsWith('/api/people/auth/')
    || p === '/api/login' || p === '/api/logout';
}

/**
 * Reject cross-site state-changing requests. Only acts on mutating methods to /api/ paths: when a
 * browser sends an Origin/Referer that is NOT same-origin, the request is blocked (classic CSRF). Non-
 * browser clients (curl, webhooks) send no Origin and are unaffected; those paths carry their own auth.
 */
export function csrfGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (!req.path.startsWith('/api/')) return next();
  if (csrfExempt(req.path)) return next();

  let originHost = '';
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  try {
    if (origin) originHost = new URL(origin).host.toLowerCase();
    else if (referer) originHost = new URL(referer).host.toLowerCase();
  } catch { originHost = '__invalid__'; }

  if (!originHost) return next(); // no browser origin header: not a cross-site form post
  if (allowedHosts(req).has(originHost)) return next();
  res.status(403).json({ ok: false, error: 'bad_origin' });
}

/** Constant-time equality for secrets/tokens of any length. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still do a comparison against a same-length buffer so timing does not leak length.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** A tiny fixed-window in-memory rate limiter. Fine for one machine; resets on restart. */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: express.Request) => string; message?: string }) {
  const hits = new Map<string, { count: number; reset: number }>();
  const keyOf = opts.key || ((req: express.Request) => (req.headers['fly-client-ip'] as string) || req.ip || 'anon');
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const now = Date.now();
    const k = keyOf(req);
    let e = hits.get(k);
    if (!e || e.reset < now) { e = { count: 0, reset: now + opts.windowMs }; hits.set(k, e); }
    e.count++;
    if (hits.size > 5000) for (const [kk, vv] of hits) if (vv.reset < now) hits.delete(kk); // opportunistic GC
    if (e.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      res.status(429).json({ ok: false, error: 'rate_limited', message: opts.message || 'Too many requests, slow down.' });
      return;
    }
    next();
  };
}
