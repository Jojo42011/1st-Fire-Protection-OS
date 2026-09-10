import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';

process.env.DB_PATH = path.join(os.tmpdir(), `godmode-test-${process.pid}.db`);
process.env.DEMO_MODE = 'off';
process.env.GOD_MODE_PASSWORD = 'break-glass-super-secret-9182';

import { initDb } from './db/schema';
import { godModeConfigured, isGodMode, handleLogin, handleLogout, godStatus, setGodPassword, clearGodPassword } from './auth';
import { currentUser } from './people/authz';

initDb();

/** Minimal express-shaped req/res doubles that capture Set-Cookie and JSON. */
function fakeReq(cookie?: string, body?: any): any {
  return { headers: cookie ? { cookie } : {}, body: body ?? {}, path: '/api/login' };
}
function fakeRes(): any {
  const res: any = { statusCode: 200, headers: {} as Record<string, any>, body: null };
  res.setHeader = (k: string, v: any) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}
/** Pull the fpos_god cookie value out of a Set-Cookie header (string or array). */
function godCookieFrom(res: any): string | null {
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of arr) {
    const m = /^fpos_god=([^;]*)/.exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

test('god mode is configured only for a sufficiently long password', () => {
  assert.equal(godModeConfigured(), true);
});

test('signing in with the god password issues a valid god session that reads as super-admin', () => {
  const res = fakeRes();
  handleLogin(fakeReq(undefined, { password: 'break-glass-super-secret-9182' }), res);
  assert.equal(res.body?.ok, true);
  assert.equal(res.body?.godMode, true);

  const token = godCookieFrom(res);
  assert.ok(token && token.length > 0, 'a fpos_god cookie must be set');

  // The signed cookie verifies, and elevates currentUser to a full people_admin, all offices.
  const authed = fakeReq(`fpos_god=${encodeURIComponent(token!)}`);
  assert.equal(isGodMode(authed), true);
  const u = currentUser(authed);
  assert.ok(u, 'god session resolves to a user');
  assert.deepEqual(u!.roles, ['people_admin']);
  assert.equal(u!.all_offices, true);
  assert.equal(u!.source, 'god-mode');
});

test('a wrong password does not grant god mode', () => {
  const res = fakeRes();
  handleLogin(fakeReq(undefined, { password: 'not-the-god-password' }), res);
  // No APP_PASSWORD is set here, so the gate is disabled and returns ok:true, but NOT godMode.
  assert.notEqual(res.body?.godMode, true);
  assert.equal(godCookieFrom(res), null, 'no god cookie for a non-god password');
});

test('a forged or tampered god cookie is rejected', () => {
  assert.equal(isGodMode(fakeReq('fpos_god=9999999999999.deadbeef')), false);
  assert.equal(isGodMode(fakeReq('fpos_god=garbage')), false);
  assert.equal(isGodMode(fakeReq()), false, 'no cookie is not god mode');
});

test('logout clears the god cookie', () => {
  const res = fakeRes();
  handleLogout(fakeReq(), res);
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : [raw];
  assert.ok(arr.some((c: string) => /^fpos_god=;/.test(c)), 'logout must expire the god cookie');
});

test('an app-managed god password (set in Access & Roles) works and is reported by status', () => {
  delete process.env.GOD_MODE_PASSWORD; // rely only on the app-managed one
  assert.equal(godModeConfigured(), false, 'off with neither source');

  const set = setGodPassword('app-managed-break-glass-77', 'admin@1stfp.com');
  assert.equal(set.ok, true);
  assert.equal(godModeConfigured(), true);
  const st = godStatus();
  assert.equal(st.configured, true);
  assert.equal(st.app_set, true);
  assert.equal(st.env_set, false);
  assert.equal(st.set_by, 'admin@1stfp.com');

  // Sign in with the app-managed password -> full super-admin.
  const res = fakeRes();
  handleLogin(fakeReq(undefined, { password: 'app-managed-break-glass-77' }), res);
  assert.equal(res.body?.godMode, true);
  const token = godCookieFrom(res)!;
  const u = currentUser(fakeReq(`fpos_god=${encodeURIComponent(token)}`));
  assert.deepEqual(u!.roles, ['people_admin']);

  // A short password is refused; clearing turns god mode back off.
  assert.equal(setGodPassword('short', 'x').ok, false);
  clearGodPassword();
  assert.equal(godModeConfigured(), false);
});

test('god mode is always off in demo mode regardless of source', () => {
  process.env.GOD_MODE_PASSWORD = 'break-glass-super-secret-9182';
  process.env.DEMO_MODE = 'on';
  try {
    assert.equal(godModeConfigured(), false, 'demo disables god mode');
    assert.equal(setGodPassword('another-strong-one-here', 'x').ok, false, 'cannot set in demo');
  } finally {
    process.env.DEMO_MODE = 'off';
  }
});
