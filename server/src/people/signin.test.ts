import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

const TENANT = '11111111-2222-3333-4444-555555555555';
process.env.DB_PATH = path.join(os.tmpdir(), `signin-test-${process.pid}.db`);
process.env.DEMO_MODE = 'off';
process.env.APP_PASSWORD = 'office-shared-password-123';
process.env.ENTRA_TENANT_ID = TENANT;
process.env.ENTRA_CLIENT_ID = 'client-abc';
process.env.ENTRA_CLIENT_SECRET = 'secret';
process.env.ENTRA_REDIRECT_URI = 'https://os.example.com/api/people/auth/callback';
delete process.env.PEOPLE_BOOTSTRAP_EMAIL;

import { initDb } from '../db/schema';
import { getDb } from '../db/index';
import { handleCallback, checkIdClaims } from './identity';
import { resolveAppUser, upsertAppUser, setAppUserActive } from './authz';
import { gate } from '../auth';

initDb();

/* A fake Microsoft: one RSA key, a JWKS endpoint, and a token endpoint that returns whatever id_token
   the test staged. Nothing leaves the process. */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as any), kid: 'k1', use: 'sig', alg: 'RS256' };
let stagedIdToken = '';
function makeIdToken(claims: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}
(globalThis as any).fetch = async (url: string) => {
  if (String(url).includes('/discovery/v2.0/keys')) return { ok: true, json: async () => ({ keys: [jwk] }) };
  return { ok: true, json: async () => ({ id_token: stagedIdToken }) };
};

function fakeRes(): any {
  const res: any = { statusCode: 200, headers: {} as Record<string, any>, body: null, redirectedTo: null };
  res.setHeader = (k: string, v: any) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.type = () => res;
  res.send = (b: any) => { res.body = b; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.redirect = (u: string) => { res.redirectedTo = u; return res; };
  return res;
}

/** Start a real sign-in to get a signed state + the nonce Microsoft would echo back. */
async function signInAs(email: string, extra: Record<string, unknown> = {}) {
  const { beginLogin } = await import('./identity');
  const start = fakeRes();
  beginLogin({} as any, start);
  const q = new URL(start.redirectedTo).searchParams;
  stagedIdToken = makeIdToken({
    aud: 'client-abc', iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT,
    exp: Math.floor(Date.now() / 1000) + 600, nonce: q.get('nonce'), preferred_username: email, name: 'Test Person', ...extra,
  });
  const res = fakeRes();
  const denied: string[] = [];
  await handleCallback({ query: { code: 'c', state: q.get('state') } } as any, res, {
    authorize: (e) => !!resolveAppUser(e),
    onDenied: (e) => denied.push(e),
  });
  const cookie = String(res.headers['set-cookie'] || '');
  return { res, denied, cookie };
}

function gateAllows(cookieHeader: string, p = '/api/deficiencies'): boolean {
  let allowed = false;
  const res = fakeRes();
  gate({ path: p, headers: { cookie: cookieHeader } } as any, res, () => { allowed = true; });
  return allowed;
}
const peopleCookie = (setCookie: string) => setCookie.split(';')[0];

test('someone Microsoft signs in who is not in Access & roles gets no session and is audited', async () => {
  const { res, denied, cookie } = await signInAs('outsider@gmail.com');
  assert.equal(res.statusCode, 403);
  assert.match(String(res.body), /You don't have access/);
  assert.match(String(res.body), /outsider@gmail\.com/);
  assert.equal(res.redirectedTo, null);
  assert.match(cookie, /fpos_people=;.*Max-Age=0/, 'any existing session is cleared');
  assert.deepEqual(denied, ['outsider@gmail.com']);
});

test('an active Access & roles user signs in and passes the gate', async () => {
  upsertAppUser('staff@1stfpservices.com', ['viewer'], 'Staff');
  const { res, cookie } = await signInAs('Staff@1stFPServices.com');
  assert.equal(res.statusCode, 200);
  assert.equal(res.redirectedTo, '/?tab=people');
  assert.match(cookie, /^fpos_people=[^;]+\./);
  assert.equal(gateAllows(peopleCookie(cookie)), true);
});

test('the gate re-checks access on every request: deactivating someone locks them out immediately', async () => {
  upsertAppUser('leaver@1stfpservices.com', ['viewer'], 'Leaver');
  const { cookie } = await signInAs('leaver@1stfpservices.com');
  assert.equal(gateAllows(peopleCookie(cookie)), true);
  setAppUserActive('leaver@1stfpservices.com', false);
  assert.equal(gateAllows(peopleCookie(cookie)), false);
});

test('a session cookie issued before this fix, for someone never granted access, no longer opens the app', async () => {
  // Simulate the old behavior: grant, sign in, then remove the row entirely (as if never added).
  upsertAppUser('guest@vendor.com', ['viewer'], 'Guest');
  const { cookie } = await signInAs('guest@vendor.com');
  getDb().prepare(`DELETE FROM app_users WHERE lower(email) = 'guest@vendor.com'`).run();
  assert.equal(gateAllows(peopleCookie(cookie)), false);
  assert.equal(gateAllows(''), false, 'no cookie at all is still refused');
});

test('id_token claims must match our app, our tenant exactly, and this sign-in nonce', () => {
  const good = { aud: 'client-abc', iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, exp: Math.floor(Date.now() / 1000) + 60, nonce: 'n1' };
  assert.doesNotThrow(() => checkIdClaims({ ...good }, 'n1'));
  assert.throws(() => checkIdClaims({ ...good, nonce: undefined }, 'n1'), /nonce/);
  assert.throws(() => checkIdClaims({ ...good, nonce: 'other' }, 'n1'), /nonce/);
  assert.throws(() => checkIdClaims({ ...good, aud: 'someone-else' }, 'n1'), /aud/);
  assert.throws(() => checkIdClaims({ ...good, iss: 'https://login.microsoftonline.com/99999999-0000-0000-0000-000000000000/v2.0' }, 'n1'), /iss/);
  assert.throws(() => checkIdClaims({ ...good, iss: `https://evil.example/${TENANT}/v2.0` }, 'n1'), /iss/);
  assert.throws(() => checkIdClaims({ ...good, tid: '99999999-0000-0000-0000-000000000000' }, 'n1'), /tenant/);
  assert.throws(() => checkIdClaims({ ...good, exp: Math.floor(Date.now() / 1000) - 5 }, 'n1'), /expired/);
});

test('a token from another tenant is refused at the callback', async () => {
  const { res, cookie } = await signInAs('staff@1stfpservices.com', { iss: 'https://login.microsoftonline.com/99999999-0000-0000-0000-000000000000/v2.0' });
  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(cookie, /^fpos_people=[^;]+\./);
});

test('only a signed-in person whose lane it is can decide an onboarding item, under their own email', async () => {
  const { decider } = await import('./decider');
  const { visibleOwners } = await import('../services/onboardingOwners');
  const lane = (owner: string) => (u: any) => { const v = visibleOwners(u); return !v || v.has(owner as any); };

  const anon = decider({ headers: {} } as any, lane('it'));
  assert.equal(anon.ok, false);
  assert.equal((anon as any).status, 401);

  upsertAppUser('hr.person@1stfpservices.com', ['hr'], 'HR Person');
  const { cookie } = await signInAs('hr.person@1stfpservices.com');
  const req = { headers: { cookie: peopleCookie(cookie) } } as any;
  const own = decider(req, lane('sandi'));
  assert.deepEqual(own.ok && { actor: own.actor }, { actor: 'hr.person@1stfpservices.com' }, 'recorded under the real email');
  const other = decider(req, lane('it'));
  assert.equal(other.ok, false);
  assert.equal((other as any).status, 403, "HR cannot approve IT's lane");

  upsertAppUser('no.role@1stfpservices.com', [], 'No Role');
  const nr = await signInAs('no.role@1stfpservices.com');
  const noRole = decider({ headers: { cookie: peopleCookie(nr.cookie) } } as any, lane('it'));
  assert.equal(noRole.ok, false, 'a mapped account with no role cannot decide');
});
