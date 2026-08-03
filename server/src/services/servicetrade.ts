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

/** Credentials present? Either an API token, or a username+password pair. */
export function stConfigured(): boolean {
  return !!(process.env.SERVICETRADE_TOKEN || (process.env.SERVICETRADE_USERNAME && process.env.SERVICETRADE_PASSWORD));
}

/** Which credential style is in play (for the settings UI; never returns the secret itself). */
export function stCredKind(): 'token' | 'password' | 'none' {
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

// ── session auth (username/password), cached in memory ──
let session: { cookie: string; expiresAt: number } | null = null;
const SESSION_TTL_MS = 1000 * 60 * 25; // re-auth well within ServiceTrade's session lifetime

async function authenticate(): Promise<void> {
  if (process.env.SERVICETRADE_TOKEN) return; // token style needs no login round-trip
  const now = Date.now();
  if (session && session.expiresAt > now) return;

  const res = await fetch(`${ST_BASE}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.SERVICETRADE_USERNAME,
      password: process.env.SERVICETRADE_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`ServiceTrade auth failed: ${res.status} ${res.statusText}`);
  // ServiceTrade returns a PHPSESSID session cookie; keep the whole cookie header to replay.
  const setCookie = res.headers.get('set-cookie') || '';
  const match = /PHPSESSID=[^;]+/.exec(setCookie);
  if (!match) throw new Error('ServiceTrade auth returned no session cookie');
  session = { cookie: match[0], expiresAt: now + SESSION_TTL_MS };
}

function authHeaders(): Record<string, string> {
  if (process.env.SERVICETRADE_TOKEN) return { authorization: `Bearer ${process.env.SERVICETRADE_TOKEN}` };
  return session ? { cookie: session.cookie } : {};
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
  if (res.status === 401 && stCredKind() === 'password') {
    session = null; // session expired — re-auth once and retry
    await authenticate();
    res = await doFetch();
  }
  if (!res.ok) throw new Error(`ServiceTrade ${m} ${path} → ${res.status} ${res.statusText}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Read helper — always safe. */
export const stGet = <T = any>(path: string): Promise<T> => stRequest<T>('GET', path);

/**
 * A harmless connection test: authenticates and does a single read. Never writes. Returns a
 * plain result the settings UI can show without leaking anything sensitive.
 */
export async function testConnection(): Promise<{ ok: boolean; detail: string }> {
  if (!stConfigured()) return { ok: false, detail: 'No ServiceTrade credentials set.' };
  try {
    // /auth is the lightest authenticated read; falls back to a 1-row customer read.
    await stGet('/auth').catch(() => stGet('/customer?limit=1'));
    return { ok: true, detail: `Connected via ${stCredKind() === 'token' ? 'API token' : 'username/password'}.` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
