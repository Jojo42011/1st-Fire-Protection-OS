import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DB_PATH = path.join(os.tmpdir(), `app-access-test-${process.pid}.db`);
process.env.DEMO_MODE = 'off';
process.env.OS_REQUIRE_IDENTITY = '0';
delete process.env.MS_GRAPH_TOKEN;

import express from 'express';
import { initDb } from '../db/schema';
import { getDb } from '../db/index';
import { seedSoftwareApps, importSoftwareCsv, employeeSoftware } from './softwareLicenses';
import { appAccessFor } from './appAccess';
import { createOffboarding, reconcileAppAccessItems } from './offboardingAgent';
import { approvalUrl } from './approvalLinks';
import approvalLinkRoutes from '../routes/approvalLinks';

initDb();
seedSoftwareApps();
const db = getDb();
const emp = (first: string, last: string, extra: Record<string, string> = {}) =>
  Number(db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, employment_status, work_email, actual_start_date) VALUES (?, ?, 'active', ?, ?)`)
    .run(first, last, extra.email || `${first}.${last}@1stfpservices.com`.toLowerCase(), extra.start || '2024-01-01').lastInsertRowid);

const allie = emp('Allie', 'Call');
const tech = emp('Tom', 'Tech');            // a field tech: never in Sage
const late = emp('Nora', 'Newer', { start: '2099-01-01' }); // started after the list was taken
const vera = emp('Melissa', 'Vera');        // Sage lists "Mel Vera", which does not match her legal name
const asked = emp('Sam', 'Sage');           // onboarding asked for Sage

const sageId = (db.prepare(`SELECT id FROM software_apps WHERE name = 'Sage Intacct'`).get() as any).id;
const stId = (db.prepare(`SELECT id FROM software_apps WHERE name = 'ServiceTrade'`).get() as any).id;

// The Sage "Users" sheet as exported (Username holds the full name, not an email).
const SAGE = [
  'User ID,Username,User type,Admin privileges,Permissions report,MGMT,Entity,Description',
  'acall,Allie Call,Business,Off,Admin,,400,Austin',
  'mvera,Mel Vera,Business,Off,Admin,,100 & 500,San Antonio',
].join('\n');

const off = (name: string, employee_id: number) => {
  const { items } = createOffboarding({ name, employee_id, termination_date: '2026-10-01' } as any);
  const by = (code: string) => items.find((i: any) => i.action_code === code) as any;
  return { sage: by('hr_sage_remove'), ap: by('acct_ap_approver'), st: by('hr_servicetrade_remove'), card: by('acct_card_cancel') };
};
const statusOf = (id: number) => (db.prepare(`SELECT status, decided_by FROM offboarding_items WHERE id = ?`).get(id) as any);

test('before any Sage list is loaded, nobody loses a Sage task', () => {
  assert.equal(appAccessFor({ employee_id: tech }, 'Sage Intacct').state, 'unknown');
  const o = off('Tom Tech', tech);
  assert.equal(statusOf(o.sage.id).status, 'pending');
});

test('the Sage export loads onto each person with their login and user type', () => {
  const r = importSoftwareCsv(sageId, SAGE, true);
  assert.deepEqual(r.recognized, ['name', 'login', 'user type']);
  assert.equal(r.matched, 1);
  assert.equal(r.unmatched, 1, 'Mel Vera does not match Melissa Vera');
  const sw = employeeSoftware(allie).find((s: any) => s.name === 'Sage Intacct');
  assert.equal(sw.external_ref, 'acall');
  assert.equal((db.prepare(`SELECT access_level FROM employee_software WHERE employee_id = ? AND app_id = ?`).get(allie, sageId) as any).access_level, 'Business');
});

test('offboarding a non-Sage user: Sage and AP steps are N/A, other Accounting steps still go out', () => {
  // The task made before the list existed closes on the next reconcile.
  const r = reconcileAppAccessItems();
  assert.ok(r.na >= 2);
  const o = off('Tom Tech 2', tech);
  assert.equal(statusOf(o.sage.id).status, 'na');
  assert.match(statusOf(o.sage.id).decided_by, /not on the Sage Intacct user list/);
  assert.equal(statusOf(o.ap.id).status, 'na');
  assert.equal(statusOf(o.card.id).status, 'pending', 'credit card is not a Sage task');
});

test('a Sage user keeps the task, and so does anyone the list cannot vouch for', () => {
  assert.equal(statusOf(off('Allie Call', allie).sage.id).status, 'pending');
  assert.equal(statusOf(off('Nora Newer', late).sage.id).status, 'pending', 'started after the list');
  assert.equal(statusOf(off('Melissa Vera', vera).sage.id).status, 'pending', 'an unmatched row shares her last name');
  db.prepare(`INSERT INTO onboarding_requests (name, employee_id, sage, status) VALUES ('Sam Sage', ?, 'AP Clerk', 'complete')`).run(asked);
  assert.equal(statusOf(off('Sam Sage', asked).sage.id).status, 'pending', 'onboarding asked for Sage');
});

test('ServiceTrade removal only goes out for people ServiceTrade lists', () => {
  const o = off('Tom Tech 3', tech);
  assert.equal(statusOf(o.st.id).status, 'pending', 'ServiceTrade list not loaded yet');
  importSoftwareCsv(stId, 'email,name\nallie.call@1stfpservices.com,Allie Call', true, 'api');
  reconcileAppAccessItems();
  assert.equal(statusOf(o.st.id).status, 'na');
  assert.equal(statusOf(off('Allie Call 2', allie).st.id).status, 'pending');
});

test('once someone is gone from the next list, their open removal step closes as done', () => {
  const o = off('Allie Call 3', allie);
  assert.equal(statusOf(o.sage.id).status, 'pending');
  importSoftwareCsv(sageId, SAGE.split('\n').filter((l) => !l.startsWith('acall')).join('\n'), true);
  reconcileAppAccessItems();
  assert.equal(statusOf(o.sage.id).status, 'done');
  assert.match(statusOf(o.sage.id).decided_by, /no longer a Sage Intacct user/);
});

test('the test approval link looks real but records nothing', async () => {
  const app = express();
  app.use(approvalLinkRoutes);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const before = (db.prepare(`SELECT COUNT(*) c FROM onboarding_items`).get() as any).c;
    const url = approvalUrl(base, 0, 'devon.booker@1stfpservices.com');
    const page = await (await fetch(url)).text();
    assert.match(page, /Test approval: nothing you choose here is recorded/);
    assert.match(page, /Test Hire/);
    const done = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=approve' })).text();
    assert.match(done, /Approved \(test\)/);
    assert.match(done, /support@liontechlabs\.com/);
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM onboarding_items`).get() as any).c, before);
  } finally { server.close(); }
});
