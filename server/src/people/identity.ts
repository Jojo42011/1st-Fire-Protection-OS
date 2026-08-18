/**
 * People / Employee Lifecycle — identity (Microsoft Entra ID sign-in).
 *
 * Company identity flow: on-prem Active Directory -> Entra Connect -> Microsoft Entra ID.
 * Employees sign in with their Microsoft identity. This module implements the OIDC
 * authorization-code flow against the tenant and validates the returned id_token before issuing
 * a signed, HttpOnly People session cookie carrying the verified email. Authorization (which
 * roles that email has) is a SEPARATE concern handled in authz.ts.
 *
 * Everything Entra is gated on configuration. When ENTRA_* is not set the module reports
 * `configured:false` and no one is silently signed in — People stays locked (the shared app
 * password is deliberately NOT enough). An explicit PEOPLE_DEV_LOGIN=1 enables a local bootstrap
 * sign-in for development only; it is never on by default.
 */
import express from 'express';
import crypto from 'crypto';

export interface Identity { email: string; name?: string | null; oid?: string | null }

const COOKIE = 'fpos_people';
const TTL_MS = 8 * 3600 * 1000; // 8h working session

export function entraConfigured(): boolean {
  return !!(process.env.ENTRA_TENANT_ID && process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET && process.env.ENTRA_REDIRECT_URI);
}
export function devLoginEnabled(): boolean {
  return process.env.PEOPLE_DEV_LOGIN === '1' && !!process.env.PEOPLE_BOOTSTRAP_EMAIL;
}

function sessionSecret(): string {
  return crypto.createHash('sha256').update('fpos-people|' + (process.env.PEOPLE_SESSION_SECRET || process.env.APP_PASSWORD || 'dev-people-secret')).digest('hex');
}
function sign(payload: object): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return body + '.' + sig;
}
function verify(token: string | undefined): Identity | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot), sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  try {
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.email || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return { email: String(data.email).toLowerCase(), name: data.name || null, oid: data.oid || null };
  } catch {
    return null;
  }
}

function readCookie(req: express.Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
function setSession(res: express.Response, id: Identity): void {
  res.setHeader('Set-Cookie', `${COOKIE}=${sign(id)}; HttpOnly; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}; SameSite=Lax; Secure`);
}

/** The current verified identity from the People session cookie, or null. */
export function currentIdentity(req: express.Request): Identity | null {
  return verify(readCookie(req, COOKIE));
}

export function signOut(res: express.Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`);
}

/* ─────────────────────────── Entra OIDC auth-code flow ─────────────────────────── */
const STATE_TTL = 10 * 60 * 1000;
function signState(nonce: string): string {
  const body = Buffer.from(JSON.stringify({ nonce, exp: Date.now() + STATE_TTL })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
}
function readState(state: string | undefined): { nonce: string } | null {
  if (!state) return null;
  const dot = state.indexOf('.');
  if (dot < 0) return null;
  const body = state.slice(0, dot), sig = state.slice(dot + 1);
  const expect = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  try {
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof d.exp !== 'number' || d.exp < Date.now()) return null;
    return { nonce: d.nonce };
  } catch { return null; }
}

/** GET /api/people/auth/login — redirect to Microsoft (or dev sign-in / not-configured). */
export function beginLogin(req: express.Request, res: express.Response): void {
  if (!entraConfigured()) {
    if (devLoginEnabled()) {
      setSession(res, { email: String(process.env.PEOPLE_BOOTSTRAP_EMAIL).toLowerCase(), name: 'Bootstrap Admin' });
      res.redirect('/?tab=people'); // back to the full shell with People open, not a bare /people
      return;
    }
    res.status(503).json({ ok: false, error: 'entra_not_configured', message: 'Microsoft sign-in is not configured yet (set ENTRA_* to enable).' });
    return;
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: process.env.ENTRA_CLIENT_ID as string,
    response_type: 'code',
    redirect_uri: process.env.ENTRA_REDIRECT_URI as string,
    response_mode: 'query',
    scope: 'openid profile email',
    state: signState(nonce),
    nonce,
  });
  res.redirect(`https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize?${params}`);
}

/** GET /api/people/auth/callback — exchange the code, validate id_token, set the session. */
export async function handleCallback(req: express.Request, res: express.Response): Promise<void> {
  if (!entraConfigured()) { res.status(503).json({ ok: false, error: 'entra_not_configured' }); return; }
  const code = String(req.query.code || '');
  const st = readState(String(req.query.state || ''));
  if (!code || !st) { res.status(400).send('Invalid sign-in state. Please try again.'); return; }
  try {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.ENTRA_CLIENT_ID as string,
        client_secret: process.env.ENTRA_CLIENT_SECRET as string,
        grant_type: 'authorization_code', code, redirect_uri: process.env.ENTRA_REDIRECT_URI as string,
        scope: 'openid profile email',
      }).toString(),
    });
    const tj = await tokenRes.json() as { id_token?: string; error_description?: string };
    if (!tokenRes.ok || !tj.id_token) { res.status(401).send('Sign-in failed: ' + (tj.error_description || tokenRes.status)); return; }
    const claims = await validateIdToken(tj.id_token, st.nonce);
    const email = (claims.email || claims.preferred_username || claims.upn || '').toLowerCase();
    if (!email) { res.status(401).send('Sign-in failed: no email in token.'); return; }
    setSession(res, { email, name: claims.name || null, oid: claims.oid || null });
    res.redirect('/?tab=people'); // back to the full shell with People open, not a bare /people
  } catch (e) {
    res.status(401).send('Sign-in failed: ' + (e as Error).message);
  }
}

/* ─────────────────────────── id_token validation (JWKS / RS256) ─────────────────────────── */
let jwksCache: { at: number; keys: any[] } | null = null;
async function jwks(): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetch(`https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/discovery/v2.0/keys`);
  const j = await r.json() as { keys?: any[] };
  jwksCache = { at: Date.now(), keys: j.keys || [] };
  return jwksCache.keys;
}
interface IdClaims { email?: string; preferred_username?: string; upn?: string; name?: string; oid?: string; iss?: string; aud?: string; exp?: number; nonce?: string }
async function validateIdToken(idToken: string, nonce: string): Promise<IdClaims> {
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) throw new Error('malformed id_token');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as IdClaims;
  const key = (await jwks()).find((k) => k.kid === header.kid);
  if (!key) throw new Error('signing key not found');
  const pub = crypto.createPublicKey({ key, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad signature');
  if (payload.aud !== process.env.ENTRA_CLIENT_ID) throw new Error('aud mismatch');
  if (!payload.iss || !payload.iss.includes(process.env.ENTRA_TENANT_ID as string)) throw new Error('iss mismatch');
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('token expired');
  if (payload.nonce && payload.nonce !== nonce) throw new Error('nonce mismatch');
  return payload;
}
