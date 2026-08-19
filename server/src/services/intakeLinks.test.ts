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
  const out = submitIntake(token, { legal: 'Nadia Farr', office: 'Houston', title: 'Service Technician', systems: ['ServiceTrade'], vehicle: 'Assigned truck', mvr: 'Yes' });
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
