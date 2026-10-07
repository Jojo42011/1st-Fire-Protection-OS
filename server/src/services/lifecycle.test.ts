import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `lifecycle-test-${process.pid}.db`);
process.env.DEMO_MODE = 'off';
process.env.OS_REQUIRE_IDENTITY = '0';
process.env.MS_GRAPH_TOKEN = 'test-token';
process.env.MS_MAIL_FROM = 'os@1stfpservices.com';

import { initDb } from '../db/schema';
import { getDb } from '../db/index';
import { seedMailSenders } from './mailSenders';
import { seedOnboardingCatalog, catalogByKind } from './onboardingCatalog';
import {
  createRequest, approveItem, rejectItem, completeItem, dueFor, setStartDate, syncStartDatesFromEmployees,
  managerEmailFor, getRequest, OWNERS, backfillDueDates,
} from './onboardingAgent';
import { notifyFollowUp, notifyRejection, notifyStartDateChange, sendOnboardingReminders, dueLabel } from './onboardingOwners';
import { autoStartOffboardings, createOffboarding, sendOffboardingOverdueReminders } from './offboardingAgent';

initDb();
seedMailSenders();
seedOnboardingCatalog();
const db = getDb();

/* Capture every email instead of sending it. */
type Sent = { to: string; subject: string; html: string };
let outbox: Sent[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  if (String(url).includes('/sendMail')) {
    const msg = JSON.parse(init.body).message;
    outbox.push({ to: msg.toRecipients[0].emailAddress.address, subject: msg.subject, html: msg.body.content });
    return { ok: true, status: 202, text: async () => '', json: async () => ({}) };
  }
  return { ok: false, status: 404, text: async () => 'unexpected', json: async () => ({}) };
};
const BASE = 'https://os.example.com';
// A Tuesday at 10am Central, inside the reminder send window.
const TUE_10AM = new Date('2026-10-06T15:00:00Z');

test('Owner (Mario) and Ops (Daniel) no longer approve or own anything', () => {
  assert.ok(!OWNERS.some((o) => o.key === 'mario' || o.key === 'daniel'), 'not offered as lanes');
  assert.ok(catalogByKind('software').every((c) => c.owner !== 'mario'), 'licensed software is approved by IT');
  assert.ok(catalogByKind('sharepoint').every((c) => c.owner !== 'mario'));
  const { items } = createRequest({ name: 'Ava Field', start_date: '2026-10-19', computer_type: 'cad', company_vehicle: true, vehicle_details: 'F-150, unit 12' });
  assert.ok(items.every((i) => i.owner !== 'mario' && i.owner !== 'daniel'));
  const computer = items.find((i) => i.label === 'Approve new computer')!;
  assert.equal(computer.owner, 'it_manager', 'the IT manager approves workstations');
  assert.equal(computer.kind, 'approval');
  const policy = items.find((i) => i.label.startsWith('Add to State Auto Policy'))!;
  assert.equal(policy.owner, 'denise');
  assert.equal(policy.detail, 'Vehicle: F-150, unit 12', 'the vehicle details go to Safety now');
});

test('due dates count business days back from the start date, and never start out overdue', () => {
  const now = new Date('2026-10-01T15:00:00Z'); // Thu Oct 1
  assert.equal(dueFor('task', '2026-10-19', now), '2026-10-16', 'a Monday start: tasks due the Friday before');
  assert.equal(dueFor('approval', '2026-10-19', now), '2026-10-12', 'approvals a week of business days before');
  assert.equal(dueFor('task', '2026-10-02', now), '2026-10-01');
  assert.equal(dueFor('approval', '2026-10-02', now), '2026-10-01', 'a rushed hire is due today, not born overdue');
  assert.equal(dueFor('task', null, now), null);
  assert.equal(dueFor('task', 'soon', now), null);
  assert.deepEqual(dueLabel('2026-09-29', now), { text: 'Overdue (Tue, Sep 29)', late: true });
  assert.deepEqual(dueLabel('2026-10-01', now), { text: 'Due today', late: false });
});

test('approving a computer, a license, or a group creates the task that delivers it, once', async () => {
  const { request, items } = createRequest({ name: 'Ben Design', start_date: '2099-03-09', computer_type: 'cad', software: ['Bluebeam'], sharepoint: ['MGMT'] });
  const find = (label: string) => items.find((i) => i.label === label)!;
  outbox = [];

  const comp = approveItem(find('Approve new computer').id, 'devon@1stfpservices.com');
  assert.equal(comp.status, 'approved');
  assert.ok(comp.followUp);
  assert.equal(comp.followUp!.owner, 'it');
  assert.equal(comp.followUp!.label, 'Order and set up new computer for Ben Design');
  assert.match(comp.followUp!.detail || '', /CAD workstation/);
  assert.equal(comp.followUp!.due_at, '2099-03-06', 'due the business day before the start');
  assert.equal(comp.followUp!.parent_id, comp.id);

  await notifyFollowUp(comp, comp.followUp!, 'devon@1stfpservices.com', BASE);
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].subject, /^Approved, next step: Onboarding tasks for Ben Design \(starts Mon, Mar 9\)/);
  assert.match(outbox[0].html, /new computer was approved by devon@1stfpservices\.com/);
  assert.match(outbox[0].html, /Order and set up new computer/);

  const lic = approveItem(find('Approve Bluebeam license').id, 'devon');
  assert.equal(lic.followUp!.label, 'Install Bluebeam');
  assert.equal(find('Approve SharePoint group: MGMT').owner, 'it_manager', 'the IT manager approves the management group');
  const grp = approveItem(find('Approve SharePoint group: MGMT').id, 'devon');
  assert.equal(grp.followUp!.owner, 'it', 'IT does the add once approved');
  assert.equal(grp.followUp!.label, 'Add to SharePoint group: MGMT', 'the label the Graph auto-provisioner already understands');

  // Clicking approve again changes nothing and adds no second task.
  const again = approveItem(find('Approve new computer').id, 'someone-else');
  assert.equal(again.followUp!.id, comp.followUp!.id);
  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM onboarding_items WHERE parent_id = ?`).get(comp.id) as any).c, 1);
  assert.equal(getRequest(request.id)!.request.status, 'open', 'the follow-up keeps the request open until delivered');
});

test('a Sage seat approval leads to an Accounting setup task without the price in its name', () => {
  db.prepare(`INSERT INTO onboarding_catalog (kind, name, owner, approval, price) VALUES ('sage', 'Project Manager', 'rebecca', 1, 45)`).run();
  const { items } = createRequest({ name: 'Cara Books', start_date: '2099-03-09', sage: 'Project Manager' });
  const sage = items.find((i) => i.label.startsWith('Approve Sage access'))!;
  assert.match(sage.label, /\(\$45\.00\)$/);
  const out = approveItem(sage.id, 'rebecca');
  assert.equal(out.followUp!.label, 'Set up Sage access: Project Manager');
  assert.equal(out.followUp!.owner, 'rebecca');
});

test('a rejection keeps its reason, flags the request, and emails the manager who asked', async () => {
  const { request, items } = createRequest({ name: 'Dee Rejected', start_date: '2099-03-09', computer_type: 'standard', manager_name: 'Pat Manager' });
  db.prepare(`INSERT INTO intake_links (token, recipient_name, recipient_email, created_by, request_id, status, expires_at) VALUES ('tok-rej', 'Pat Manager', 'pat@1stfpservices.com', 'hr', ?, 'submitted', '2099-12-31')`).run(request.id);
  assert.equal(managerEmailFor(request.id), 'pat@1stfpservices.com');

  // Finish everything else so the rejection is the last open item.
  for (const it of items) if (it.kind === 'task') completeItem(it.id, 'hr');
  const rej = rejectItem(items.find((i) => i.label === 'Approve new computer')!.id, 'devon@1stfpservices.com', 'Reuse the spare laptop in Waco instead.');
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.note, 'Reuse the spare laptop in Waco instead.');
  assert.equal(getRequest(request.id)!.request.status, 'needs_attention', 'not a green "complete"');

  outbox = [];
  const sent = await notifyRejection(rej, 'devon@1stfpservices.com', BASE);
  assert.deepEqual(sent, { ok: true, to: 'pat@1stfpservices.com' });
  assert.equal(outbox[0].subject, 'Not approved: new computer for Dee Rejected');
  assert.match(outbox[0].html, /Reuse the spare laptop in Waco instead\./);
});

test('the manager email falls back to the roster when no intake link exists', () => {
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, employment_status) VALUES ('Quinn', 'Lead', 'quinn.lead@1stfpservices.com', 'active')`).run();
  const { request } = createRequest({ name: 'Eli New', manager_name: 'Quinn Lead' });
  assert.equal(managerEmailFor(request.id), 'quinn.lead@1stfpservices.com');
  const { request: r2 } = createRequest({ name: 'Fay New', manager_name: 'Nobody Known' });
  assert.equal(managerEmailFor(r2.id), null);
});

test('moving the start date re-dates open tasks, leaves finished ones, and tells the owners', async () => {
  const { request, items } = createRequest({ name: 'Gus Moved', start_date: '2099-03-09', company_email: true, teams_number: true });
  completeItem(items.find((i) => i.label === 'Set up Teams number')!.id, 'it');
  setStartDate(request.id, '2099-03-23');
  const after = db.prepare(`SELECT label, status, due_at FROM onboarding_items WHERE request_id = ?`).all(request.id) as any[];
  assert.equal(after.find((i) => i.label === 'Set up company email').due_at, '2099-03-20');
  assert.equal(after.find((i) => i.label === 'Set up Teams number').due_at, '2099-03-06', 'a finished task keeps its date');
  const record = db.prepare(`SELECT detail FROM onboarding_items WHERE request_id = ? AND label LIKE 'Create employee in BambooHR%'`).get(request.id) as any;
  assert.match(record.detail, /Start date: 2099-03-23/, 'the BambooHR task text follows the new date');

  outbox = [];
  await notifyStartDateChange(request.id, '2099-03-09', BASE);
  const it = outbox.find((m) => m.to === 'support@liontechlabs.com')!;
  assert.match(it.subject, /^Start date changed: Onboarding tasks for Gus Moved \(starts Mon, Mar 23\)/);
  assert.match(it.html, /changed from Monday, March 9, 2099/);
  assert.match(it.html, /Set up company email/);
  assert.doesNotMatch(it.html, /Set up Teams number/, 'only what is still open');
});

test('a start date that moves in BambooHR follows into the open onboarding', () => {
  const emp = Number(db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, employment_status, anticipated_start_date) VALUES ('Hal', 'Hire', 'onboarding', '2099-04-06')`).run().lastInsertRowid);
  const { request } = createRequest({ name: 'Hal Hire', employee_id: emp, start_date: '2099-03-30', company_email: true });
  const moved = syncStartDatesFromEmployees();
  assert.deepEqual(moved.filter((m) => m.id === request.id), [{ id: request.id, name: 'Hal Hire', from: '2099-03-30', to: '2099-04-06' }]);
  assert.equal(getRequest(request.id)!.request.start_date, '2099-04-06');
  assert.equal(syncStartDatesFromEmployees().filter((m) => m.id === request.id).length, 0, 'no repeat once in sync');
});

test('requests made before due dates existed get dated at startup', () => {
  const { request, items } = createRequest({ name: 'Ida Old', start_date: '2099-05-04', company_email: true });
  db.prepare(`UPDATE onboarding_items SET due_at = NULL WHERE request_id = ?`).run(request.id);
  assert.ok(backfillDueDates() >= items.length);
  assert.ok((db.prepare(`SELECT due_at FROM onboarding_items WHERE request_id = ?`).all(request.id) as any[]).every((r) => r.due_at));
});

test('the daily reminder sends each lane one email of what is due soon or late, once a day, in business hours', async () => {
  db.prepare(`UPDATE onboarding_requests SET status = 'complete'`).run(); // isolate from earlier tests
  const { request } = createRequest({ name: 'Jo Soon', start_date: '2026-10-07', company_email: true, cell_reimburse: true });
  db.prepare(`UPDATE onboarding_items SET due_at = '2026-10-05' WHERE request_id = ? AND owner = 'it'`).run(request.id); // yesterday: overdue
  outbox = [];
  const out = await sendOnboardingReminders(BASE, TUE_10AM);
  const it = outbox.find((m) => m.to === 'support@liontechlabs.com')!;
  const hr = outbox.find((m) => m.to === 'hr@1stfpservices.com')!;
  assert.ok(out.sent >= 2 && it && hr);
  assert.equal(it.subject, '1 overdue, 1 onboarding task due');
  assert.match(it.html, /Jo Soon/);
  assert.match(it.html, /Overdue \(Mon, Oct 5\)/);
  assert.match(hr.html, /Cell-phone reimbursement/);

  outbox = [];
  await sendOnboardingReminders(BASE, new Date(TUE_10AM.getTime() + 3600_000));
  assert.equal(outbox.length, 0, 'once a day per address');
  const night = await sendOnboardingReminders(BASE, new Date('2026-10-07T03:00:00Z'));
  assert.equal(night.waiting, true, 'not at 10pm');
});

test('a BambooHR termination starts offboarding once, and IT and HR hear about it', () => {
  const emp = Number(db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, upn, employment_status) VALUES ('Kim', 'Leaver', 'kim.leaver@1stfpservices.com', 'kim.leaver@1stfpservices.com', 'terminated')`).run().lastInsertRowid);
  const started = autoStartOffboardings([emp], new Date('2026-10-06T15:00:00Z'));
  assert.equal(started.length, 1);
  const req = db.prepare(`SELECT source, created_by, termination_date, upn FROM offboarding_requests WHERE id = ?`).get(started[0].id) as any;
  assert.deepEqual(req, { source: 'bamboo', created_by: 'BambooHR sync', termination_date: '2026-10-06', upn: 'kim.leaver@1stfpservices.com' });
  assert.equal(autoStartOffboardings([emp]).length, 0, 'never a second offboarding for the same person');
});

test('overdue offboarding steps go to each department once a day', async () => {
  db.prepare(`UPDATE offboarding_requests SET status = 'complete'`).run();
  createOffboarding({ name: 'Lee Gone', upn: 'lee.gone@1stfpservices.com', manager_email: 'boss@1stfpservices.com', termination_date: '2026-09-28' });
  outbox = [];
  const out = await sendOffboardingOverdueReminders(BASE, TUE_10AM);
  const to = outbox.map((m) => m.to).sort();
  assert.deepEqual(to, ['accounting@1stfpservices.com', 'boss@1stfpservices.com', 'devon.booker@1stfpservices.com', 'hr@1stfpservices.com', 'laura.shannon@1stfpservices.com', 'safety@1stfpservices.com', 'support@liontechlabs.com']);
  const it = outbox.find((m) => m.to === 'support@liontechlabs.com')!;
  assert.match(it.subject, /offboarding steps? overdue$/);
  assert.match(it.html, /Lee Gone<\/b>: Disable the AD account/);
  assert.match(it.html, /8 days overdue/);
  // Online work to IT support; devices and building access to the IT manager.
  assert.doesNotMatch(it.html, /Receive all assigned devices|key fob|ID badge/);
  const devon = outbox.find((m) => m.to === 'devon.booker@1stfpservices.com')!;
  assert.match(devon.html, /Receive all assigned devices/);
  assert.match(devon.html, /Deactivate key fob/);
  assert.match(devon.html, /Collect the company ID badge/);
  assert.doesNotMatch(devon.html, /Disable the AD account|Microsoft 365 license/);
  assert.match(devon.html, /Open offboarding/);
  // Laura handles ServiceTrade only: her reminder is that one step, not the IT list.
  const laura = outbox.find((m) => m.to === 'laura.shannon@1stfpservices.com')!;
  assert.match(laura.html, /Remove the user from ServiceTrade/);
  assert.doesNotMatch(laura.html, /Disable the AD account|Receive all assigned devices/);
  assert.match(laura.subject, /^1 offboarding step overdue$/);
  assert.doesNotMatch(laura.html, /Open offboarding/, 'Laura does not sign in to the OS');
  assert.ok(out.sent === 7);
  outbox = [];
  await sendOffboardingOverdueReminders(BASE, new Date(TUE_10AM.getTime() + 3600_000));
  assert.equal(outbox.length, 0, 'once a day per address');
});

test('new-computer and MGMT approvals email the IT manager; the rest of IT goes to IT support', async () => {
  const { notifyOwners } = await import('./onboardingOwners');
  const out = createRequest({ name: 'Mia Route', start_date: '2099-06-01', computer_type: 'business', sharepoint: ['MGMT'], company_email: true, software: ['Bluebeam'] });
  outbox = [];
  await notifyOwners(out.request, out.items, BASE);
  const devon = outbox.find((m) => m.to === 'devon.booker@1stfpservices.com')!;
  const msp = outbox.find((m) => m.to === 'support@liontechlabs.com')!;
  assert.ok(devon, 'the IT manager gets an email');
  assert.match(devon.html, /Approve new computer/);
  assert.match(devon.html, /Approve SharePoint group: MGMT/);
  assert.doesNotMatch(devon.html, /Set up company email/);
  assert.match(devon.html, /Approve Bluebeam license/, 'paid licenses are the IT manager\'s call too');
  assert.doesNotMatch(msp.html, /Approve Bluebeam license/);
  assert.doesNotMatch(msp.html, /Approve new computer|Approve SharePoint group: MGMT/, 'IT support does not get these approvals');
  assert.match(msp.html, /Set up company email/);
});

test("IT support sees the hire's hiring manager; Laura's emails have no board button", async () => {
  const { notifyOwners } = await import('./onboardingOwners');
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, employment_status) VALUES ('Hank', 'Hiring', 'hank.hiring@1stfpservices.com', 'active')`).run();
  const hire = Number(db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, employment_status, manager) VALUES ('Ivy', 'Intake', 'onboarding', 'Hiring, Hank')`).run().lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO onboarding_catalog (kind, name, owner, approval) VALUES ('servicetrade', 'Technician', 'laura', 0)`).run();
  const out = createRequest({ name: 'Ivy Intake', employee_id: hire, start_date: '2099-06-01', company_email: true, servicetrade: 'Technician' } as any);
  outbox = [];
  await notifyOwners(out.request, out.items, BASE);
  const msp = outbox.find((m) => m.to === 'support@liontechlabs.com')!;
  assert.match(msp.html, /<b>Hiring manager:<\/b> Hank Hiring &middot; <a href="mailto:hank\.hiring@1stfpservices\.com"/);
  assert.match(msp.html, /Open the onboarding board/);
  const laura = outbox.find((m) => m.to === 'laura.shannon@1stfpservices.com')!;
  assert.match(laura.html, /ServiceTrade access: Technician/);
  assert.doesNotMatch(laura.html, /Open the onboarding board/);
  assert.doesNotMatch(laura.html, /Hiring manager/, 'only IT support gets the manager line');
});

test('the example IT support email carries the hiring manager and leaves nothing behind', () => {
  const { exampleItEmail } = require('./onboardingOwners');
  const db = require('../db/index').getDb();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM onboarding_requests`).get().n;
  const ex = exampleItEmail('https://os.example');
  assert.ok(ex, 'built from the newest roster hire');
  assert.match(ex.subject, /^\[Example\] Onboarding tasks for /);
  assert.match(ex.html, /Hiring manager:/);
  assert.doesNotMatch(ex.html, /Review and approve/, 'no action buttons on an example');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM onboarding_requests`).get().n, before, 'nothing saved');
});
