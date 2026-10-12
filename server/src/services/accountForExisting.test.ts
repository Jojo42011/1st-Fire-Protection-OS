import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-acct-existing-test-${process.pid}.db`);

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { ingestInventory } from './adAudit';
import { catalogByKind } from './onboardingCatalog';
import { existingEmployeeCandidates, createAccountRequest } from './accountForExisting';
import { buildProvisionPlan } from './adProvision';

initDb();
const db = getDb();
db.exec(`DELETE FROM employees; DELETE FROM ad_users;`);
const emp = (first: string, last: string, email: string | null, status = 'active') =>
  Number(db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, office, job_position, actual_start_date, employment_status) VALUES (?,?,?, '1st FP Austin, LLC', 'Inspector', '2026-03-02', ?)`)
    .run(first, last, email, status).lastInsertRowid);
const has = emp('Ann', 'Austin', 'ann@1stfp.com');
const none = emp('Zed', 'Field', null);
emp('Old', 'Gone', null, 'terminated');
ingestInventory([{ objectGuid: 'g1', sam: 'ann', upn: 'ann@1stfp.com', displayName: 'Ann Austin', enabled: true, ou: 'OU=Austin,DC=corp,DC=local' }]);

test('candidates: active BambooHR people, the ones without an AD account first', () => {
  const c = existingEmployeeCandidates();
  assert.equal(c.adSynced, true);
  assert.deepEqual(c.people.map((p) => p.name), ['Zed Field', 'Ann Austin'], 'terminated left out; no-account first');
  assert.equal(c.people[0].ad, null);
  assert.equal(c.people[1].ad && c.people[1].ad.sam, 'ann');
});

test('creates one IT task (plus groups picked), no hiring tasks, and blocks a duplicate', () => {
  const sp = catalogByKind('sharepoint').find((g) => !/all\s*staff/i.test(g.name) && !g.approval);
  const out = createAccountRequest({ employee_id: none, account_type: 'AD + Email', sharepoint: sp ? [sp.name] : [], note: 'Field tech, needs email for ServiceTrade' });
  assert.equal(out.request.request_type, 'account_only');
  assert.equal(out.warning, null);
  const labels = out.items.map((i) => `${i.owner}:${i.label}`);
  assert.equal(labels[0], 'it:Create AD account and company email');
  assert.ok(!out.items.some((i) => i.owner === 'bamboo' || i.owner === 'sandi'), 'no BambooHR or benefits tasks');
  if (sp) assert.ok(labels.includes(`${sp.owner}:Add to SharePoint group: ${sp.name}`));
  assert.match(out.items[0].detail || '', /Field tech/);
  const plan = buildProvisionPlan(out.request.id);
  assert.equal(plan.upn.split('@')[0], 'zed.field');
  assert.equal(plan.description, 'AD + Email', 'the account type picked by hand');
  assert.throws(() => createAccountRequest({ employee_id: none }), /already open/);
});

test('warns when AD already has an enabled account for them', () => {
  const out = createAccountRequest({ employee_id: has });
  assert.match(out.warning || '', /ann/);
  assert.equal(buildProvisionPlan(out.request.id).description, 'Email Only');
});
