import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DB_PATH = path.join(os.tmpdir(), `approval-links-test-${process.pid}.db`);
process.env.DEMO_MODE = 'off';
process.env.OS_REQUIRE_IDENTITY = '0';
delete process.env.MS_GRAPH_TOKEN;

import express from 'express';
import { initDb, setState } from '../db/schema';
import { getDb } from '../db/index';
import { seedOnboardingCatalog } from './onboardingCatalog';
import { createRequest, rerouteComputerApprovalsToManagers, resolveHireManager } from './onboardingAgent';
import { signApproval, verifyApproval, approvalUrl } from './approvalLinks';
import { recipientFor } from './onboardingOwners';
import approvalLinkRoutes from '../routes/approvalLinks';

initDb();
seedOnboardingCatalog();
const db = getDb();

// The hire's manager, as BambooHR stores the supervisor ("Last, First") and the roster has them.
db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, employment_status) VALUES ('Pat', 'Smith', 'pat.smith@1stfpservices.com', 'active')`).run();
const hireId = Number(db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, employment_status, manager) VALUES ('Nia', 'Newhire', 'onboarding', 'Smith, Pat')`).run().lastInsertRowid);

const app = express();
app.use(approvalLinkRoutes);
const server = http.createServer(app);
let base = '';
test.before(async () => { await new Promise<void>((r) => server.listen(0, r)); base = `http://127.0.0.1:${(server.address() as any).port}`; });
test.after(() => { server.close(); });

test("the laptop approval goes to the hire's manager from BambooHR; IT support still gets the setup", () => {
  assert.deepEqual(resolveHireManager({ employee_id: hireId }), { name: 'Smith, Pat', email: 'pat.smith@1stfpservices.com', source: 'bamboo' });
  const { items } = createRequest({ name: 'Nia Newhire', employee_id: hireId, start_date: '2099-02-02', computer_type: 'standard', company_email: true });
  const ap = items.find((i) => i.label === 'Approve new computer')!;
  assert.equal(ap.owner, 'manager');
  assert.equal(ap.email_to, 'pat.smith@1stfpservices.com');
  assert.match(ap.detail || '', /Manager: Smith, Pat \(from BambooHR\)/);
  assert.equal(recipientFor(ap), 'pat.smith@1stfpservices.com');
  assert.equal(recipientFor(items.find((i) => i.label === 'Set up company email')!), 'support@liontechlabs.com');
});

test('with no manager email on file, the approval falls back to the IT manager instead of getting lost', () => {
  const { items } = createRequest({ name: 'No Boss', manager_name: 'Unknown Person', computer_type: 'standard' });
  const ap = items.find((i) => i.label === 'Approve new computer')!;
  assert.equal(ap.owner, 'it_manager');
  assert.equal(recipientFor(ap), 'devon.booker@1stfpservices.com');
  assert.match(ap.detail || '', /No manager email found in BambooHR for "Unknown Person"/);
});

test('approval links are bound to one item and one person, and cannot be forged or reused after expiry', () => {
  const t = signApproval(42, 'Pat.Smith@1stfpservices.com');
  assert.deepEqual(verifyApproval(t), { itemId: 42, email: 'pat.smith@1stfpservices.com' });
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ i: 43, e: 'pat.smith@1stfpservices.com', x: Date.now() + 1e9 })).toString('base64url');
  assert.equal(verifyApproval(`${forged}.${sig}`), null, 'a different item with the old signature');
  assert.equal(verifyApproval(`${body}.x${sig.slice(1)}`), null);
  assert.equal(verifyApproval(signApproval(42, 'p@x.com', Date.now() - 31 * 86400000)), null, 'expired after 30 days');
  assert.equal(verifyApproval('garbage'), null);
});

test('the manager opens the link, approves, and IT gets "Order and set up new computer"', async () => {
  const { items } = createRequest({ name: 'Omar Laptop', employee_id: hireId, start_date: '2099-02-02', computer_type: 'business' });
  const ap = items.find((i) => i.label === 'Approve new computer')!;
  const url = approvalUrl(base, ap.id, ap.email_to!);

  const view = await fetch(url);
  assert.equal(view.status, 200);
  const html = await view.text();
  assert.match(html, /Approval needed/);
  assert.match(html, /Omar Laptop/);
  assert.equal((db.prepare(`SELECT status FROM onboarding_items WHERE id = ?`).get(ap.id) as any).status, 'pending', 'opening the link decides nothing');

  const done = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=approve' });
  assert.match(await done.text(), /IT has been asked to order and set up new computer for Omar Laptop/);
  const row = db.prepare(`SELECT status, decided_by FROM onboarding_items WHERE id = ?`).get(ap.id) as any;
  assert.deepEqual(row, { status: 'approved', decided_by: 'pat.smith@1stfpservices.com' });
  const follow = db.prepare(`SELECT owner, label FROM onboarding_items WHERE parent_id = ?`).get(ap.id) as any;
  assert.deepEqual(follow, { owner: 'it', label: 'Order and set up new computer for Omar Laptop' });
  assert.equal(recipientFor(follow), 'support@liontechlabs.com');

  const again = await (await fetch(url)).text();
  assert.match(again, /Already approved/);
  assert.match(again, /pat\.smith@1stfpservices\.com/);
});

test("a manager can turn it down with a reason, and a bad link shows a clear page", async () => {
  const { request, items } = createRequest({ name: 'Pia NoLaptop', employee_id: hireId, computer_type: 'cad' });
  const ap = items.find((i) => i.label === 'Approve new computer')!;
  for (const it of items) if (it.kind === 'task') db.prepare(`UPDATE onboarding_items SET status = 'done' WHERE id = ?`).run(it.id);
  const res = await fetch(approvalUrl(base, ap.id, ap.email_to!), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=reject&reason=Use+the+spare+in+Waco' });
  assert.match(await res.text(), /Not approved/);
  const row = db.prepare(`SELECT status, note FROM onboarding_items WHERE id = ?`).get(ap.id) as any;
  assert.deepEqual(row, { status: 'rejected', note: 'Use the spare in Waco' });
  assert.equal((db.prepare(`SELECT status FROM onboarding_requests WHERE id = ?`).get(request.id) as any).status, 'needs_attention');

  const bad = await fetch(`${base}/approve/not-a-real-token`);
  assert.equal(bad.status, 404);
  assert.match(await bad.text(), /not valid anymore/);
});

test('open laptop approvals made before this change move to the hire\'s manager once', () => {
  const { items } = createRequest({ name: 'Old Pending', employee_id: hireId, computer_type: 'standard' });
  const ap = items.find((i) => i.label === 'Approve new computer')!;
  db.prepare(`UPDATE onboarding_items SET owner = 'it_manager', email_to = NULL WHERE id = ?`).run(ap.id);
  setState('onboarding_computer_to_manager_v1', '0');
  assert.ok(rerouteComputerApprovalsToManagers() >= 1);
  const row = db.prepare(`SELECT owner, email_to FROM onboarding_items WHERE id = ?`).get(ap.id) as any;
  assert.deepEqual(row, { owner: 'manager', email_to: 'pat.smith@1stfpservices.com' });
  assert.equal(rerouteComputerApprovalsToManagers(), 0, 'runs once');
});
