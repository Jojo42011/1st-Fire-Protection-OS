import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-intake-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import {
  createIntakeLink,
  listIntakeLinks,
  resolveToken,
  markOpened,
  submitIntake,
  resendIntakeLink,
  nudgeIntakeLink,
  voidIntakeLink,
  getSubmission,
} from './intakeLinks';

initDb();
const db = getDb();
db.exec(`DELETE FROM intake_links; DELETE FROM onboarding_requests; DELETE FROM onboarding_items;`);

test('create issues a usable token with a 7-day expiry and sent status', () => {
  const { link, token } = createIntakeLink({ job_title: 'Inspector', office: 'Houston', recipient_name: 'Dana Cole' });
  assert.ok(token.length > 10, 'token generated');
  assert.equal(link.status, 'sent');
  const days = (new Date(link.expires_at).getTime() - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, 'expires in ~7 days');
  const r = resolveToken(token);
  assert.equal(r.ok, true);
});

test('opening marks the link opened; list carries a shareable url only while usable', () => {
  const { token } = createIntakeLink({ job_title: 'Estimator', office: 'Austin', recipient_name: 'Sam Lee' });
  markOpened(token);
  const row = resolveToken(token);
  assert.equal(row.ok, true);
  const listed = listIntakeLinks('https://x.test').find((l) => l.recipient_name === 'Sam Lee')!;
  assert.equal(listed.status, 'opened');
  assert.ok(listed.url && listed.url.startsWith('https://x.test/intake/'), 'usable link carries url');
});

test('submit is single-use: creates an onboarding request and closes the token', () => {
  const { token } = createIntakeLink({ job_title: 'Service Technician', office: 'Houston', recipient_name: 'Rex Poe' });
  const out = submitIntake(token, { legal: 'Nadia Farr', office: 'Houston', title: 'Service Technician', accounts: ['Company email'], safety_gear: ['WEX fuel card'], company_vehicle: true });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.ok(out.request_id > 0, 'onboarding request created');
    assert.ok(out.teams.length > 0, 'items routed to teams');
  }
  // second submit on the same token is rejected
  const again = submitIntake(token, { legal: 'Someone Else' });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, 'already_submitted');
  // resolve now refuses it, and the stored submission is retrievable by link id
  const r = resolveToken(token);
  assert.equal(r.ok, false);
  const listed = listIntakeLinks().find((l) => l.recipient_name === 'Rex Poe')!;
  assert.equal(listed.status, 'submitted');
  assert.equal(listed.url, null, 'submitted link is not shareable');
  const sub = getSubmission(listed.id);
  assert.equal(sub.legal, 'Nadia Farr');
});

test('a link bound to a confirmed hire pre-fills identity and attaches the request to that employee', () => {
  const empId = Number(db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, entra_display_name, job_position, office, manager, employment_status) VALUES ('Maria','Reyes','Maria Reyes','Service Fitter','McAllen','Ed Valdez','onboarding')`).run().lastInsertRowid);
  const { link, token } = createIntakeLink({ employee_id: empId });
  // The link snapshots role/office from the employee, and carries the bound hire.
  assert.equal(link.job_title, 'Service Fitter');
  assert.equal(link.office, 'McAllen');
  assert.ok(link.hire && link.hire.name === 'Maria Reyes');
  // The manager submits ONLY operational fields (no identity); it still attaches to Maria.
  const out = submitIntake(token, { computer_type: 'cad', accounts: ['Company email'], printers: [] });
  assert.equal(out.ok, true);
  if (out.ok) {
    const req = db.prepare(`SELECT name, employee_id, job_position, computer_type FROM onboarding_requests WHERE id = ?`).get(out.request_id) as any;
    assert.equal(req.employee_id, empId, 'request bound to the real employee');
    assert.equal(req.name, 'Maria Reyes', 'name came from BambooHR, not the manager');
    assert.equal(req.job_position, 'Service Fitter');
    assert.equal(req.computer_type, 'cad');
  }
});

test('submit refuses a payload with no name', () => {
  const { token } = createIntakeLink({ job_title: 'Dispatcher', office: 'Austin', recipient_name: 'No Name' });
  const out = submitIntake(token, { legal: '', preferred: '' });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'name_required');
});

test('resend voids the old token and issues a fresh one', () => {
  const { link, token } = createIntakeLink({ job_title: 'Inspector', office: 'Houston', recipient_name: 'Kira Vance' });
  const out = resendIntakeLink(link.id, 'tester')!;
  assert.ok(out && out.token && out.token !== token, 'a new token is issued');
  // old token is now void
  const old = resolveToken(token);
  assert.equal(old.ok, false);
  if (!old.ok) assert.equal(old.reason, 'voided');
  // the new token works
  assert.equal(resolveToken(out.token).ok, true);
});

test('an expired token resolves as expired', () => {
  const { token } = createIntakeLink({ job_title: 'Estimator', office: 'Austin', recipient_name: 'Past Due' });
  // force expiry into the past
  db.prepare(`UPDATE intake_links SET expires_at = datetime('now','-1 day') WHERE token = ?`).run(token);
  const r = resolveToken(token);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'expired');
  const listed = listIntakeLinks().find((l) => l.recipient_name === 'Past Due')!;
  assert.equal(listed.status, 'expired');
});

test('nudge only timestamps a still-open link', () => {
  const { link, token } = createIntakeLink({ job_title: 'Inspector', office: 'Houston', recipient_name: 'Nudge Me' });
  assert.equal(nudgeIntakeLink(link.id), true);
  // a submitted link cannot be nudged
  submitIntake(token, { legal: 'Nudge Me' });
  assert.equal(nudgeIntakeLink(link.id), false);
});

test('discard voids a live link so it can no longer be opened or submitted', () => {
  const { link, token } = createIntakeLink({ job_title: 'Dispatcher', office: 'Austin', recipient_name: 'Discard Me' });
  assert.equal(resolveToken(token).ok, true);
  const out = voidIntakeLink(link.id);
  assert.equal(out.ok, true);
  const r = resolveToken(token);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'voided');
  assert.equal(submitIntake(token, { legal: 'Discard Me' }).ok, false);
  // idempotent, and a submitted link cannot be discarded
  assert.equal(voidIntakeLink(link.id).ok, true);
  const { link: l2, token: t2 } = createIntakeLink({ job_title: 'Inspector', office: 'Houston', recipient_name: 'Already In' });
  submitIntake(t2, { legal: 'Already In' });
  const blocked = voidIntakeLink(l2.id);
  assert.equal(blocked.ok, false);
});

test('a test link previews the teams but creates no request, closes the token, and stays off the list', () => {
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM onboarding_requests`).get() as { n: number }).n;
  const itemsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM onboarding_items`).get() as { n: number }).n;
  const { link, token } = createIntakeLink({ recipient_name: 'Test Manager', test: true });
  assert.equal(listIntakeLinks().some((l) => l.id === link.id), false, 'test links are hidden from the board');
  const out = submitIntake(token, { legal: 'Try Out', title: 'Inspector', start: '2030-01-07', accounts: ['Company email'] });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.test, true);
    assert.ok(out.teams.length > 0, 'reports which teams a real submit would reach');
  }
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM onboarding_requests`).get() as { n: number }).n, before, 'no request kept');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM onboarding_items`).get() as { n: number }).n, itemsBefore, 'no tasks kept');
  const again = resolveToken(token);
  assert.equal(again.ok, false, 'single-use like a real link');
});

test('a link made without an email gets the hire\'s manager from BambooHR, and a nudge gives it 7 fresh days', async () => {
  const { ensureRecipientEmail, backfillRecipientEmails, nudgeIntakeLink } = await import('./intakeLinks');
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, employment_status) VALUES ('Ray','Ellis','ray.ellis@1stfpservices.com','active')`).run();
  const hireId = Number(db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, manager, employment_status) VALUES ('Jo','Hire','Ellis, Ray','onboarding')`).run().lastInsertRowid);
  const { link } = createIntakeLink({ employee_id: hireId });
  assert.equal(link.recipient_email, 'ray.ellis@1stfpservices.com', 'filled from BambooHR at creation');
  assert.equal(link.recipient_name, 'Ray Ellis', 'first name first');

  // An older link saved with no email is filled in when the board loads.
  db.prepare(`UPDATE intake_links SET recipient_email = NULL WHERE id = ?`).run(link.id);
  assert.equal(backfillRecipientEmails() >= 1, true);
  assert.equal((db.prepare(`SELECT recipient_email FROM intake_links WHERE id = ?`).get(link.id) as any).recipient_email, 'ray.ellis@1stfpservices.com');

  // A typed email wins when BambooHR has none.
  const orphan = createIntakeLink({ recipient_name: 'Nobody Known' }).link;
  assert.equal(ensureRecipientEmail(orphan.id), null);
  assert.equal(ensureRecipientEmail(orphan.id, 'Boss@1stFPservices.com'), 'boss@1stfpservices.com');

  // Nudge pushes the expiry 7 days out; an expired link cannot be nudged.
  db.prepare(`UPDATE intake_links SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() + 3600_000).toISOString(), link.id);
  assert.equal(nudgeIntakeLink(link.id), true);
  const days = (Date.parse((db.prepare(`SELECT expires_at FROM intake_links WHERE id = ?`).get(link.id) as any).expires_at) - Date.now()) / 86400000;
  assert.ok(days > 6.9, 'fresh 7 days');
  db.prepare(`UPDATE intake_links SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?`).run(link.id);
  assert.equal(nudgeIntakeLink(link.id), false, 'expired: resend instead');
});

test('the intake form asks for ONE work phone, and badge, fob and card become tasks for the right people', () => {
  const att = createIntakeLink({ recipient_name: 'Phone Test' });
  const out = submitIntake(att.token, { legal: 'Pat Phone', phone: 'att', accounts: ['Company email'], access_items: ['Company ID badge', 'Key fob / access card', 'Company credit card'] });
  assert.equal(out.ok, true);
  const items = db.prepare(`SELECT owner, label FROM onboarding_items WHERE request_id = ?`).all((out as any).request_id) as { owner: string; label: string }[];
  const has = (owner: string, re: RegExp) => items.some((i) => i.owner === owner && re.test(i.label));
  assert.ok(has('it_manager', /AT&T line/), 'AT&T phone goes to the IT manager');
  assert.ok(!items.some((i) => /Teams number/.test(i.label)), 'not a Teams number too');
  assert.ok(has('it_manager', /ID badge/));
  assert.ok(has('it_manager', /key fob/i));
  assert.ok(has('rebecca', /credit card/));
  assert.ok(has('sandi', /Employee Navigator/), 'every hire is enrolled in benefits');

  const teams = createIntakeLink({ recipient_name: 'Phone Test' });
  const out2 = submitIntake(teams.token, { legal: 'Tia Teams', phone: 'teams' });
  const items2 = db.prepare(`SELECT label FROM onboarding_items WHERE request_id = ?`).all((out2 as any).request_id) as { label: string }[];
  assert.ok(items2.some((i) => /Teams number/.test(i.label)));
  assert.ok(!items2.some((i) => /AT&T/.test(i.label)));
});

test('an AT&T phone can reuse someone\'s old phone, and the IT manager is told which', () => {
  const l = createIntakeLink({ recipient_name: 'Reuse Test' });
  const out = submitIntake(l.token, { legal: 'Ria Reuse', phone: 'att', phone_reuse: "Mike Lopez's old phone" }) as any;
  const items = db.prepare(`SELECT owner, label, detail FROM onboarding_items WHERE request_id = ?`).all(out.request_id) as any[];
  const t = items.find((i) => /Reassign an old company cell phone/.test(i.label));
  assert.ok(t && t.owner === 'it_manager');
  assert.match(t.detail, /Mike Lopez's old phone/);
  assert.ok(!items.some((i) => /Order an AT&T line/.test(i.label)), 'no new line ordered');
  const teams = submitIntake(createIntakeLink({ recipient_name: 'Reuse Test' }).token, { legal: 'Tom Teams', phone: 'teams', phone_reuse: 'ignored' }) as any;
  assert.equal((db.prepare(`SELECT phone_reuse FROM onboarding_requests WHERE id = ?`).get(teams.request_id) as any).phone_reuse, null, 'only kept for an AT&T phone');
});
