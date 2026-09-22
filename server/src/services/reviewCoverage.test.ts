import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-review-coverage-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { initDb } from '../db/schema';
import { getDb } from '../db/index';
import { coverageReport, coverageCsv, coverageJobs } from './reviewCoverage';
import { pendingReviewJobs } from './reviewRequests';

initDb();
const db = getDb();
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

db.prepare(`INSERT INTO accounts (id, name) VALUES (1, 'Acme Storage'), (2, 'Bell Clinic'), (3, '=HYPERLINK("x")')`).run();
db.prepare(`INSERT INTO review_targets (office_id, office_name, review_url, active) VALUES ('on', '1st FP Waco LLC', 'https://g.page/r/W/review', 1), ('off', '1st FP Laredo LLC', 'https://g.page/r/L/review', 0)`).run();
const job = db.prepare(
  `INSERT INTO crm_jobs (st_id, account_id, status, completed_at, source, office_id, office_name, contact_email, contact_phone, contact_mobile, review_requested)
   VALUES (?, ?, 'Completed', ?, 'servicetrade', ?, ?, ?, ?, ?, ?)`
);
const sentJob = Number(job.run('j1', 1, ago(10), 'on', '1st FP Waco LLC', 'a@acme.com', '(254) 555-0101', '254-555-0101', 1).lastInsertRowid);
job.run('j2', 1, ago(40), 'on', '1st FP Waco LLC', 'a@acme.com', '254-555-0101', null, 1); // same customer, deduped
job.run('j3', 2, ago(20), 'on', '1st FP Waco LLC', null, '1 254 555 0199', null, 0); // text-only
job.run('j4', null, ago(20), 'on', '1st FP Waco LLC', null, null, null, 0); // no contact
job.run('j5', 3, ago(20), 'off', '1st FP Laredo LLC', 'c@x.com', null, null, 0); // office paused
job.run('j6', null, ago(400), 'on', '1st FP Waco LLC', 'old@x.com', null, null, 0); // too old
job.run('j7', null, ago(5), 'on', '1st FP Waco LLC', 'new@x.com', null, null, 0); // waiting
db.prepare(`INSERT INTO review_requests (job_id, customer, body, source, status, sent_at, clicked_at) VALUES (?, 'Acme', 'b', 'servicetrade', 'sent', ?, ?)`)
  .run(sentJob, ago(9), ago(8));

test('every completed job gets exactly one status with the right reason', () => {
  const byNum = Object.fromEntries(coverageJobs().map((j) => [j.id, j.reason]));
  const r = coverageReport();
  assert.equal(r.completed, 7);
  assert.deepEqual(r.byReason, {
    sent: 1, queued: 0, repeat_customer: 1, no_email_has_phone: 1, no_contact: 1, office_off: 1, too_old: 1, waiting: 1,
  });
  assert.equal(byNum[sentJob], 'sent');
});

test('phone counts dedupe numbers across formats and track mobiles and text-only customers', () => {
  const p = coverageReport().phones;
  assert.equal(p.jobsWithPhone, 3);
  assert.equal(p.uniqueNumbers, 2); // 254-555-0101 (twice, two formats) and 254-555-0199
  assert.equal(p.uniqueMobiles, 1);
  assert.equal(p.textOnlyNumbers, 1);
});

test('one-time customers and the annual-inspection-due slice', () => {
  const o = coverageReport().oneOff;
  // Acme has 2 jobs; Bell, account 3, and the three account-less jobs are one-offs.
  assert.equal(o.customers, 5);
  assert.equal(o.annualDue, 1); // the job from 400 days ago
});

test('the automatic sweep never reaches jobs older than 180 days', () => {
  const ids = pendingReviewJobs(1000).map((j: any) => j.id);
  const old = db.prepare(`SELECT id FROM crm_jobs WHERE st_id = 'j6'`).get() as { id: number };
  const fresh = db.prepare(`SELECT id FROM crm_jobs WHERE st_id = 'j7'`).get() as { id: number };
  assert.ok(!ids.includes(old.id));
  assert.ok(ids.includes(fresh.id));
});

test('the CSV lists every job and neutralizes spreadsheet formulas', () => {
  const csv = coverageCsv();
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 8);
  assert.ok(lines[0].startsWith('job_number,completed,office'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(!/,=HYPERLINK/.test(csv));
});
