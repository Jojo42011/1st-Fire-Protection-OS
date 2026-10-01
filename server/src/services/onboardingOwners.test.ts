import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `onboarding-owners-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { initDb } from '../db/schema';
import { createRequest } from './onboardingAgent';
import { ownerEmailPreview, startDateInfo } from './onboardingOwners';

initDb();

test('start date reads as a full date with a countdown, in Central time', () => {
  // 9pm Central on Sep 30 is already Oct 1 in UTC; the countdown must still count from Sep 30.
  const now = new Date('2026-10-01T02:00:00Z');
  assert.deepEqual(startDateInfo('2026-10-05', now), { long: 'Monday, October 5, 2026', short: 'Mon, Oct 5', relative: 'in 5 days' });
  assert.equal(startDateInfo('2026-09-30', now)?.relative, 'today');
  assert.equal(startDateInfo('2026-10-01', now)?.relative, 'tomorrow');
  assert.equal(startDateInfo('2026-09-28', now)?.relative, '2 days ago');
  assert.equal(startDateInfo('2026-10-05T00:00:00.000Z', now)?.long, 'Monday, October 5, 2026', 'BambooHR timestamps work too');
  assert.deepEqual(startDateInfo('next Monday', now), { long: 'next Monday', short: 'next Monday', relative: null });
  assert.equal(startDateInfo('', now), null);
  assert.equal(startDateInfo(null, now), null);
});

test('the IT lane email carries the hire start date in the subject and body', () => {
  const { request } = createRequest({ name: 'Dana Lee', start_date: '2099-01-05', company_email: true, teams_number: true });
  const p = ownerEmailPreview(request.id, 'it', 'https://os.example.com');
  assert.ok(p);
  assert.match(p!.subject, /^Onboarding tasks for Dana Lee \(starts Mon, Jan 5\): IT/);
  assert.match(p!.html, /Start date:<\/b> Monday, January 5, 2099/);
  assert.match(p!.html, /before their first day/);
  assert.match(p!.text, /Start date: Monday, January 5, 2099 \(in \d+ days\)/);
  assert.equal(p!.count, 2);
});

test('a hire with no start date says so instead of leaving IT guessing', () => {
  const { request } = createRequest({ name: 'No Date', company_email: true });
  const p = ownerEmailPreview(request.id, 'it', 'https://os.example.com');
  assert.equal(p!.subject, 'Onboarding tasks for No Date: IT (provisioning)');
  assert.match(p!.html, /Start date:<\/b> not provided yet/);
  assert.match(p!.text, /Start date: not provided yet/);
});
