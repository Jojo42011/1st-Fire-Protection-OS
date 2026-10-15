import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-offb-backlog-test-${process.pid}.db`);

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { createFromBacklog } from './offboardingBacklog';
import { backfillManagerAddresses, createOffboarding } from './offboardingAgent';

initDb();
const db = getDb();
db.exec(`DELETE FROM offboarding_items; DELETE FROM offboarding_requests; DELETE FROM ad_users; DELETE FROM employees;`);

const addEmp = (first: string, last: string, email: string, status: string, manager: string | null) =>
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, upn, employment_status, manager) VALUES (?,?,?,?,?,?)`)
    .run(first, last, email, email, status, manager);
const addAd = (guid: string, upn: string, name: string) =>
  db.prepare(`INSERT INTO ad_users (object_guid, upn, sam, display_name, enabled) VALUES (?,?,?,?,1)`).run(guid, upn, upn.split('@')[0], name);
const req = (id: number) => db.prepare(`SELECT manager_email, forward_to FROM offboarding_requests WHERE id = ?`).get(id) as any;

addEmp('Ray', 'Boss', 'ray.boss@1stfpservices.com', 'active', null);

test('backlog resolves the supervisor name to a work email in either name order', () => {
  addEmp('Lee', 'Gone', 'lee.gone@1stfpservices.com', 'terminated', 'Ray Boss');
  addEmp('Kim', 'Left', 'kim.left@1stfpservices.com', 'terminated', 'Boss, Ray');
  addAd('g-lee', 'lee.gone@1stfpservices.com', 'Lee Gone');
  addAd('g-kim', 'kim.left@1stfpservices.com', 'Kim Left');
  const out = createFromBacklog(['g-lee', 'g-kim']);
  assert.equal(out.created, 2);
  for (const id of out.ids) {
    assert.deepEqual(req(id), { manager_email: 'ray.boss@1stfpservices.com', forward_to: 'ray.boss@1stfpservices.com' });
  }
});

test('an unresolvable supervisor name leaves the manager email empty, never the name', () => {
  addEmp('Pat', 'Away', 'pat.away@1stfpservices.com', 'terminated', 'Nobody Known');
  addAd('g-pat', 'pat.away@1stfpservices.com', 'Pat Away');
  const out = createFromBacklog(['g-pat']);
  assert.deepEqual(req(out.ids[0]), { manager_email: null, forward_to: null });
});

test('createOffboarding never stores a name in manager_email or forward_to', () => {
  const a = createOffboarding({ name: 'Sam Gone', manager_email: 'Ray Boss', forward_to: 'Boss, Ray' }).request;
  assert.deepEqual(req(a.id), { manager_email: 'ray.boss@1stfpservices.com', forward_to: 'ray.boss@1stfpservices.com' });
  const b = createOffboarding({ name: 'Al Gone', manager_email: 'Nobody Known' }).request;
  assert.deepEqual(req(b.id), { manager_email: null, forward_to: null });
  const c = createOffboarding({ name: 'Bo Gone', manager_email: 'boss@1stfpservices.com' }).request;
  assert.deepEqual(req(c.id), { manager_email: 'boss@1stfpservices.com', forward_to: 'boss@1stfpservices.com' });
});

test('startup backfill fixes a name stored on open requests only, and is idempotent', () => {
  const put = (name: string, mgr: string | null, fwd: string | null, status: string) =>
    Number(db.prepare(`INSERT INTO offboarding_requests (name, manager_email, forward_to, status) VALUES (?,?,?,?)`)
      .run(name, mgr, fwd, status).lastInsertRowid);
  const open = put('Old One', 'Ray Boss', 'Boss, Ray', 'open');
  const lost = put('Old Two', 'Nobody Known', 'Nobody Known', 'open');
  const mixed = put('Old Three', 'keep@1stfpservices.com', 'Ray Boss', 'open');
  const done = put('Old Four', 'Ray Boss', 'Ray Boss', 'complete');
  const item = Number(db.prepare(`INSERT INTO offboarding_items (request_id, owner, kind, label, status) VALUES (?,?,?,?,?)`)
    .run(open, 'it', 'task', 'Forward mail', 'done').lastInsertRowid);

  assert.equal(backfillManagerAddresses(), 3);
  assert.deepEqual(req(open), { manager_email: 'ray.boss@1stfpservices.com', forward_to: 'ray.boss@1stfpservices.com' });
  assert.deepEqual(req(lost), { manager_email: null, forward_to: null });
  assert.deepEqual(req(mixed), { manager_email: 'keep@1stfpservices.com', forward_to: 'ray.boss@1stfpservices.com' });
  assert.deepEqual(req(done), { manager_email: 'Ray Boss', forward_to: 'Ray Boss' });
  assert.equal((db.prepare(`SELECT status FROM offboarding_items WHERE id = ?`).get(item) as any).status, 'done');
  assert.equal(backfillManagerAddresses(), 0);
});
