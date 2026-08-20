import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-edits-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import * as svc from './service';

initDb();
const db = getDb();
db.exec(`DELETE FROM employees; DELETE FROM employee_assets; DELETE FROM employee_access; DELETE FROM employee_credentials; DELETE FROM people_audit;`);
db.prepare(`INSERT INTO employees (id, legal_first_name, legal_last_name, work_email, office, employment_status) VALUES (1,'Jane','Smith','jane@1stfp.com','McAllen','active')`).run();

const historyCount = () => (db.prepare(`SELECT COUNT(*) c FROM people_audit WHERE employee_id = 1`).get() as any).c;

test('assets: add, return, remove all land on history', () => {
  const a = svc.addAsset(1, { asset_type: 'laptop', identifier: 'LT-9', status: 'assigned' }, 'tester') as any;
  assert.ok(a.id > 0);
  assert.equal(a.status, 'assigned');
  assert.ok(a.assigned_at, 'assigned stamps a date');
  const upd = svc.updateAsset(a.id, { status: 'returned', received_by: 'IT' }, 'tester') as any;
  assert.equal(upd.status, 'returned');
  assert.ok(upd.returned_at, 'return stamps returned_at');
  assert.equal(svc.removeAsset(a.id, 'tester').ok, true);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM employee_assets WHERE id = ?`).get(a.id) as any).c, 0);
  assert.ok(historyCount() >= 3, 'add + update + remove each audited');
});

test('access: add provisioned, revoke, remove', () => {
  const g = svc.addAccess(1, { system: 'SharePoint: Shared', status: 'provisioned' }, 'tester') as any;
  assert.equal(g.status, 'provisioned');
  assert.ok(g.provisioned_at);
  const rev = svc.updateAccessStatus(g.id, 'revoked', 'tester') as any;
  assert.equal(rev.status, 'revoked');
  assert.ok(rev.revoked_at);
  assert.equal(svc.removeAccess(g.id, 'tester').ok, true);
});

test('credentials: add unverified, mark verified stamps verifier, remove', () => {
  const c = svc.addCredential(1, { credential_type: 'nicet_2', status: 'required', expires_at: '2027-01-01' }, 'tester') as any;
  assert.equal(c.status, 'required');
  const v = svc.updateCredential(c.id, { status: 'verified' }, 'auditor') as any;
  assert.equal(v.status, 'verified');
  assert.ok(v.verified_at, 'verify stamps a date');
  assert.equal(v.verified_by, 'auditor');
  assert.equal(svc.removeCredential(c.id, 'tester').ok, true);
});

test('note writes to the timeline', () => {
  const before = historyCount();
  svc.addNote(1, 'Called about missing badge', 'tester');
  assert.equal(historyCount(), before + 1);
  const last = db.prepare(`SELECT action, detail FROM people_audit WHERE employee_id = 1 ORDER BY id DESC LIMIT 1`).get() as any;
  assert.equal(last.action, 'note');
  assert.equal(last.detail, 'Called about missing badge');
});

test('access group provisioning: records the grant even when M365 is not connected', async () => {
  // No MS_GRAPH_* in this test env, so graphConfigured() is false: the grant is recorded as
  // requested with a clear message, and nothing throws.
  const out = await svc.provisionAccessGroup(1, { group_name: 'SG-PR-MCA', group_id: 'abc123' }, 'tester');
  assert.equal(out.ok, true);
  assert.equal(out.provisioned, false);
  assert.match(String(out.message), /not connected/i);
  const row = db.prepare(`SELECT system, label, status, external_ref FROM employee_access WHERE employee_id = 1 AND system = 'SG-PR-MCA'`).get() as any;
  assert.equal(row.status, 'requested');
  assert.equal(row.external_ref, 'abc123');
  assert.equal(row.label, 'Security group: SG-PR-MCA');
  const de = await svc.deprovisionAccessGroup((db.prepare(`SELECT id FROM employee_access WHERE system='SG-PR-MCA'`).get() as any).id, 'tester');
  assert.equal(de.ok, true);
  assert.equal(de.removed, false);
  assert.equal((db.prepare(`SELECT status FROM employee_access WHERE system='SG-PR-MCA'`).get() as any).status, 'revoked');
});

test('syncing access from M365 is keyless-safe when Graph is not connected', async () => {
  const out = await svc.syncAccessFromM365(1, 'tester');
  assert.equal(out.ok, false);
  assert.match(String(out.error), /not connected/i);
  const bulk = svc.startBulkAccessSync('tester');
  assert.equal(bulk.ok, false);
  assert.equal(bulk.started, false);
  assert.match(String(bulk.error), /not connected/i);
  assert.equal(svc.bulkAccessSyncStatus().running, false);
});

test('listAccessGroups reads security groups from the onboarding catalog', () => {
  db.exec(`DELETE FROM onboarding_catalog;`);
  db.prepare(`INSERT INTO onboarding_catalog (kind, name, group_name, group_id, active) VALUES ('printer','McAllen','SG-PR-MCA','g-mca',1)`).run();
  db.prepare(`INSERT INTO onboarding_catalog (kind, name, active) VALUES ('printer','No Group',1)`).run();
  const groups = svc.listAccessGroups();
  assert.ok(groups.some((g) => g.name === 'SG-PR-MCA' && g.id === 'g-mca'));
  assert.ok(!groups.some((g) => g.name === null || g.name === ''), 'only rows with a group_name are returned');
});

test('edits reject a missing employee or empty required field', () => {
  assert.throws(() => svc.addAsset(999, { asset_type: 'laptop' }, 'tester'), /employee_not_found/);
  assert.throws(() => svc.addAsset(1, { asset_type: '' }, 'tester'), /asset_type_required/);
  assert.throws(() => svc.addAccess(1, { system: '' }, 'tester'), /system_required/);
  assert.throws(() => svc.addNote(1, '   ', 'tester'), /note_required/);
});
