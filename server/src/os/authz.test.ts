import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';

process.env.DB_PATH = path.join(os.tmpdir(), `authz-test-${process.pid}.db`);
process.env.DEMO_MODE = 'off';

import { decide, AuthMode } from './authz';
import { OsContext } from './scope';
import { P } from './policy';
import { AppUser, Role } from '../people/authz';
import { timingSafeEqualStr } from './security';
import { vapiWebhookAuth } from '../routes/callWebhook';
import { secretOk } from '../routes/servicetradeWebhook';
import { adminSecretGuard } from '../routes/admin';

function legacyCtx(allOffices = true): OsContext {
  return { user: null, email: null, roles: [], allOffices, offices: [], legacy: true };
}
function userCtx(roles: Role[], offices: string[] = [], all = true): OsContext {
  const user: AppUser = { email: 'u@x.com', display_name: 'U', roles, active: true, source: 'test', offices, all_offices: all };
  return { user, email: user.email, roles, allOffices: all, offices, legacy: false };
}

/* ---- Category 1: legacy / hybrid / enforce behavior ---- */
test('legacy mode allows any gated session, even sensitive', () => {
  assert.deepEqual(decide('legacy', legacyCtx(), P.estimating_write), { allow: true });
  assert.deepEqual(decide('legacy', legacyCtx(), P.pricing_write), { allow: true });
});

test('hybrid allows a shared-password read but blocks a sensitive write (Category 2)', () => {
  assert.deepEqual(decide('hybrid', legacyCtx(), P.estimating_read), { allow: true });
  const d = decide('hybrid', legacyCtx(), P.estimating_write);
  assert.equal(d.allow, false);
  assert.equal((d as any).status, 401);
  assert.equal((d as any).error, 'identity_required');
});

test('enforce requires identity for reads too', () => {
  const d = decide('enforce', legacyCtx(), P.estimating_read);
  assert.equal(d.allow, false);
  assert.equal((d as any).status, 401);
});

/* ---- Category 4: pricing authority ---- */
test('a role without pricing authority cannot write price book / margins', () => {
  // safety has pricing:0 -> forbidden; partner has pricing:2 -> allowed; accounting pricing:2 -> allowed
  const safety = decide('hybrid', userCtx(['safety']), P.pricing_write);
  assert.equal(safety.allow, false);
  assert.equal((safety as any).status, 403);
  assert.equal(decide('hybrid', userCtx(['partner']), P.pricing_write).allow, true);
  assert.equal(decide('hybrid', userCtx(['accounting']), P.pricing_write).allow, true);
});

test('a viewer can read estimating but not write; hr cannot even read deficiencies', () => {
  assert.equal(decide('enforce', userCtx(['viewer']), P.estimating_read).allow, true);
  assert.equal(decide('enforce', userCtx(['viewer']), P.estimating_write).allow, false); // viewer deficiencies:1 < 2
  assert.equal(decide('enforce', userCtx(['hr']), P.estimating_read).allow, false);       // hr deficiencies:0
});

/* ---- Category 7: webhook secret behavior in live mode ---- */
test('vapi webhook rejects when secret missing in live mode, accepts in demo', () => {
  assert.equal(vapiWebhookAuth('', undefined, true), 'missing_secret');
  assert.equal(vapiWebhookAuth('', undefined, false), 'ok');
  assert.equal(vapiWebhookAuth('wrong', 'secret', true), 'invalid');
  assert.equal(vapiWebhookAuth('secret', 'secret', true), 'ok');
});

test('servicetrade webhook requires the secret in live mode', () => {
  const mk = (headers: Record<string, string>, query: Record<string, string> = {}) => ({ headers, query } as any);
  process.env.DEMO_MODE = 'off';
  delete process.env.SERVICETRADE_WEBHOOK_SECRET;
  assert.equal(secretOk(mk({})), false, 'live mode with no secret configured must reject');
  process.env.SERVICETRADE_WEBHOOK_SECRET = 'st-secret';
  assert.equal(secretOk(mk({ 'x-webhook-token': 'st-secret' })), true);
  assert.equal(secretOk(mk({ 'x-webhook-token': 'nope' })), false);
  delete process.env.SERVICETRADE_WEBHOOK_SECRET;
});

/* ---- Category 6: admin endpoints fail closed when unconfigured in production ---- */
function fakeRes() {
  return { code: 0, body: null as any, status(c: number) { this.code = c; return this; }, json(o: any) { this.body = o; return this; } };
}
test('admin guard fails closed in production without ADMIN_TOKEN', () => {
  process.env.DEMO_MODE = 'off';
  delete process.env.ADMIN_TOKEN;
  const res = fakeRes(); let nexted = false;
  adminSecretGuard({ get: () => undefined, query: {} } as any, res as any, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'admin_not_configured');
});

test('admin guard enforces the token when configured', () => {
  process.env.DEMO_MODE = 'off';
  process.env.ADMIN_TOKEN = 'topsecret';
  let nexted = false; const bad = fakeRes();
  adminSecretGuard({ get: () => 'wrong', query: {} } as any, bad as any, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(bad.code, 401);
  nexted = false; const good = fakeRes();
  adminSecretGuard({ get: (h: string) => (h === 'x-admin-token' ? 'topsecret' : undefined), query: {} } as any, good as any, () => { nexted = true; });
  assert.equal(nexted, true);
  delete process.env.ADMIN_TOKEN;
});

test('admin guard stays open only in demo mode with no token', () => {
  process.env.DEMO_MODE = 'on';
  delete process.env.ADMIN_TOKEN;
  let nexted = false; const res = fakeRes();
  adminSecretGuard({ get: () => undefined, query: {} } as any, res as any, () => { nexted = true; });
  assert.equal(nexted, true);
  process.env.DEMO_MODE = 'off';
});

/* ---- timing-safe compare ---- */
test('timingSafeEqualStr compares correctly', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
});
