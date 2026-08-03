import { getState, setState } from '../db/schema';

/**
 * The ServiceTrade client — the ONE place the app talks to ServiceTrade, and the ONE place
 * the read-only / write safety gate is enforced.
 *
 * SAFETY DOCTRINE: every call goes through stRequest(). Any non-GET (POST/PUT/DELETE — anything
 * that could mutate real ServiceTrade data) is HARD-BLOCKED unless the sync mode is 'read_write'.
 * The mode defaults to 'read_only' and is a persisted setting a human flips in the app. So while
 * we're testing, the app can read all it wants but physically cannot change anything in the real
 * ServiceTrade account — the write never leaves the building.
 *
 * Keyless-safe: with no credentials the client reports not-connected and every call throws a
 * typed error the callers already tolerate (the sync surface stays in its fixture/shell state).
 */

const ST_BASE = (process.env.SERVICETRADE_BASE_URL || 'https://api.servicetrade.com/api').replace(/\/$/, '');
const MODE_KEY = 'st_sync_mode';
export type StMode = 'read_only' | 'read_write';

/** Credentials present? OAuth2 client-credentials (preferred), a static API token, or username+password. */
export function stConfigured(): boolean {
  return stCredKind() !== 'none';
}

/** Which credential style is in play (for the settings UI; never returns the secret itself). */
export function stCredKind(): 'oauth2' | 'token' | 'password' | 'none' {
  if (process.env.SERVICETRADE_CLIENT_ID && process.env.SERVICETRADE_CLIENT_SECRET) return 'oauth2';
  if (process.env.SERVICETRADE_TOKEN) return 'token';
  if (process.env.SERVICETRADE_USERNAME && process.env.SERVICETRADE_PASSWORD) return 'password';
  return 'none';
}

/** The persisted safety mode. Defaults to read_only — the safe default, always. */
export function getStMode(): StMode {
  return getState(MODE_KEY) === 'read_write' ? 'read_write' : 'read_only';
}
export function setStMode(mode: StMode): StMode {
  const next: StMode = mode === 'read_write' ? 'read_write' : 'read_only';
  setState(MODE_KEY, next);
  return next;
}
export function canWrite(): boolean {
  return getStMode() === 'read_write';
}

// Typed errors so callers can tell "we chose not to" from "it broke".
export class ServiceTradeNotConnectedError extends Error {
  constructor() {
    super('ServiceTrade is not connected (no credentials configured)');
    this.name = 'ServiceTradeNotConnectedError';
  }
}
export class ServiceTradeReadOnlyError extends Error {
  method: string;
  path: string;
  constructor(method: string, path: string) {
    super(`Blocked ${method} ${path}: ServiceTrade is in read-only mode. Flip the mode to "write" in Settings to allow changes.`);
    this.name = 'ServiceTradeReadOnlyError';
    this.method = method;
    this.path = path;
  }
}

// ── auth, cached in memory ──
// One cache slot holds whichever credential is live: a Bearer access token (OAuth2) or a
// PHPSESSID session cookie (username/password). Static tokens need no round-trip.
let auth: { kind: 'bearer' | 'cookie'; value: string; expiresAt: number } | null = null;
const SESSION_TTL_MS = 1000 * 60 * 25; // password sessions: re-auth well within ServiceTrade's lifetime

/** OAuth2 client-credentials: POST /oauth2/token → a Bearer JWT, cached until just before expiry. */
async function oauth2Token(): Promise<void> {
  const now = Date.now();
  if (auth?.kind === 'bearer' && auth.expiresAt > now) return;
  const res = await fetch(`${ST_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.SERVICETRADE_CLIENT_ID,
      client_secret: process.env.SERVICETRADE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`ServiceTrade OAuth2 token failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number; data?: { access_token?: string; expires_in?: number } };
  const access = body.access_token || body.data?.access_token;
  const expiresIn = body.expires_in || body.data?.expires_in || 3600;
  if (!access) throw new Error('ServiceTrade OAuth2 token response had no access_token');
  auth = { kind: 'bearer', value: access, expiresAt: now + Math.max(60, expiresIn - 60) * 1000 };
}

/** Username/password: POST /auth → a PHPSESSID cookie, cached. */
async function passwordSession(): Promise<void> {
  const now = Date.now();
  if (auth?.kind === 'cookie' && auth.expiresAt > now) return;
  const res = await fetch(`${ST_BASE}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.SERVICETRADE_USERNAME, password: process.env.SERVICETRADE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`ServiceTrade auth failed: ${res.status} ${res.statusText}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const match = /PHPSESSID=[^;]+/.exec(setCookie);
  if (!match) throw new Error('ServiceTrade auth returned no session cookie');
  auth = { kind: 'cookie', value: match[0], expiresAt: now + SESSION_TTL_MS };
}

async function authenticate(): Promise<void> {
  const kind = stCredKind();
  if (kind === 'oauth2') return oauth2Token();
  if (kind === 'token') return; // static Bearer needs no round-trip
  if (kind === 'password') return passwordSession();
}

function authHeaders(): Record<string, string> {
  const kind = stCredKind();
  if (kind === 'token') return { authorization: `Bearer ${process.env.SERVICETRADE_TOKEN}` };
  if (kind === 'oauth2' && auth?.kind === 'bearer') return { authorization: `Bearer ${auth.value}` };
  if (kind === 'password' && auth?.kind === 'cookie') return { cookie: auth.value };
  return {};
}

/**
 * The one guarded request path. GET is always allowed (when connected); any mutating method is
 * refused unless the mode is read_write — and refused BEFORE any network call, so a read-only app
 * can never touch real ServiceTrade data.
 */
export async function stRequest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const m = method.toUpperCase();
  if (!stConfigured()) throw new ServiceTradeNotConnectedError();
  if (m !== 'GET' && !canWrite()) throw new ServiceTradeReadOnlyError(m, path);

  await authenticate();
  const url = path.startsWith('http') ? path : `${ST_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  const doFetch = () =>
    fetch(url, {
      method: m,
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: body != null && m !== 'GET' ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch();
  if (res.status === 401 && (stCredKind() === 'password' || stCredKind() === 'oauth2')) {
    auth = null; // session/token expired — re-auth once and retry
    await authenticate();
    res = await doFetch();
  }
  if (!res.ok) throw new Error(`ServiceTrade ${m} ${path} → ${res.status} ${res.statusText}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Read helper — always safe. */
export const stGet = <T = any>(path: string): Promise<T> => stRequest<T>('GET', path);

// ── webhook management (against ServiceTrade's native /webhook API) ──
// Listing is a read (always allowed). Registering/deleting a webhook CHANGES ServiceTrade
// config, so they go through stRequest as writes — gated by the read-only/write mode.

export function listWebhooks(): Promise<any> {
  return stGet('/webhook');
}
/** Subscribe a URL to ServiceTrade events. entityEvents=null → all events. (WRITE — gated.) */
export function registerWebhook(hookUrl: string, entityEvents: unknown[] | null = null): Promise<any> {
  return stRequest('POST', '/webhook', { hookUrl, enabled: true, entityEvents });
}
/** Remove a webhook subscription by id. (WRITE — gated.) */
export function deleteWebhook(id: number): Promise<any> {
  return stRequest('DELETE', `/webhook/${id}`);
}

/**
 * A harmless connection test: authenticates and does a single read. Never writes. Returns a
 * plain result the settings UI can show without leaking anything sensitive.
 */
export async function testConnection(): Promise<{ ok: boolean; detail: string }> {
  if (!stConfigured()) return { ok: false, detail: 'No ServiceTrade credentials set.' };
  try {
    // /auth is the lightest authenticated read; falls back to a 1-row customer read.
    await stGet('/auth').catch(() => stGet('/customer?limit=1'));
    const via = { oauth2: 'OAuth2 client credentials', token: 'API token', password: 'username/password', none: 'nothing' }[stCredKind()];
    return { ok: true, detail: `Connected via ${via}.` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
