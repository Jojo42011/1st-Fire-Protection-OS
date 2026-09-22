import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-review-requests-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';
process.env.PUBLIC_BASE_URL = 'https://os.example.com';

import { initDb } from '../db/schema';
import { getDb } from '../db/index';
import {
  techPhrase, inSendWindow, startOfSendDay, recordClick, remindersDue, runReviewSweep, setMode, dailySent,
} from './reviewRequests';

initDb();
const db = getDb();
const DAY = 24 * 60 * 60 * 1000;

test('techPhrase names one or two techs by first name, and skips crews of 3+ and junk', () => {
  assert.equal(techPhrase('["Marcus Smith"]'), 'Marcus');
  assert.equal(techPhrase('["MARCUS SMITH","jose garcia"]'), 'Marcus and Jose');
  assert.equal(techPhrase('["Marcus Smith","Marcus Smith"]'), 'Marcus');
  assert.equal(techPhrase('["A One","B Two","C Three"]'), null);
  assert.equal(techPhrase('["Tech 42"]'), null);
  assert.equal(techPhrase(null), null);
  assert.equal(techPhrase('not json'), null);
});

test('send window is weekdays 8am to 6pm Central, across daylight saving', () => {
  assert.equal(inSendWindow(new Date('2026-09-22T13:00:00Z')), true); // Tue 8:00 CDT
  assert.equal(inSendWindow(new Date('2026-09-22T12:59:00Z')), false); // Tue 7:59 CDT
  assert.equal(inSendWindow(new Date('2026-09-22T22:59:00Z')), true); // Tue 5:59pm CDT
  assert.equal(inSendWindow(new Date('2026-09-22T23:00:00Z')), false); // Tue 6:00pm CDT
  assert.equal(inSendWindow(new Date('2026-09-26T16:00:00Z')), false); // Saturday
  assert.equal(inSendWindow(new Date('2026-01-13T14:00:00Z')), true); // Tue 8:00 CST
  assert.equal(inSendWindow(new Date('2026-01-13T13:59:00Z')), false); // Tue 7:59 CST
});

test('the send day starts at midnight Central, not UTC', () => {
  assert.equal(startOfSendDay(new Date('2026-09-22T03:00:00Z')), '2026-09-21T05:00:00.000Z'); // 10pm CDT on the 21st
  assert.equal(startOfSendDay(new Date('2026-09-22T15:00:00Z')), '2026-09-22T05:00:00.000Z');
  assert.equal(startOfSendDay(new Date('2026-01-13T15:00:00Z')), '2026-01-13T06:00:00.000Z');
});

function addRequest(fields: Record<string, any>): number {
  const cols = { customer: 'Acme', body: 'b', source: 'servicetrade', status: 'sent', recipient_email: 'a@x.com', review_url: 'https://g.page/r/X/review', ...fields };
  const keys = Object.keys(cols);
  const r = db.prepare(`INSERT INTO review_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => (cols as any)[k]));
  return Number(r.lastInsertRowid);
}

test('recordClick counts a person, ignores mail scanners, and redirects only to the stored link', () => {
  const now = new Date();
  const id = addRequest({ token: 'tokClickAAAAAAAA', sent_at: new Date(now.getTime() - 60 * 60 * 1000).toISOString() });
  const browser = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126 Safari/537.36';

  assert.deepEqual(recordClick('nope'), { url: null, counted: false });
  assert.deepEqual(recordClick('tokUnknownAAAAAAA', { userAgent: browser }), { url: null, counted: false });

  assert.equal(recordClick('tokClickAAAAAAAA', { method: 'HEAD', userAgent: browser }).counted, false);
  assert.equal(recordClick('tokClickAAAAAAAA', { userAgent: 'Microsoft Office SafeLinks' }).counted, false);
  assert.equal(recordClick('tokClickAAAAAAAA', { userAgent: '' }).counted, false);
  let row = db.prepare(`SELECT clicked_at, click_count FROM review_requests WHERE id = ?`).get(id) as any;
  assert.equal(row.clicked_at, null);

  const out = recordClick('tokClickAAAAAAAA', { userAgent: browser });
  assert.deepEqual(out, { url: 'https://g.page/r/X/review', counted: true });
  recordClick('tokClickAAAAAAAA', { userAgent: browser });
  row = db.prepare(`SELECT clicked_at, click_count FROM review_requests WHERE id = ?`).get(id) as any;
  assert.ok(row.clicked_at);
  assert.equal(row.click_count, 2);
});

test('a hit seconds after delivery is treated as a scanner, not a click', () => {
  const now = new Date();
  const id = addRequest({ token: 'tokFreshAAAAAAAA', sent_at: new Date(now.getTime() - 20 * 1000).toISOString() });
  const out = recordClick('tokFreshAAAAAAAA', { userAgent: 'Mozilla/5.0 Chrome/126', now });
  assert.equal(out.url, 'https://g.page/r/X/review');
  assert.equal(out.counted, false);
  assert.equal((db.prepare(`SELECT clicked_at FROM review_requests WHERE id = ?`).get(id) as any).clicked_at, null);
});

test('reminders go only to tracked, unclicked, unreminded requests sent 4 to 14 days ago', () => {
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
  const due = addRequest({ token: 'tokDueAAAAAAAAAA', sent_at: ago(5) });
  addRequest({ token: 'tokTooNewAAAAAAA', sent_at: ago(2) });
  addRequest({ token: 'tokTooOldAAAAAAA', sent_at: ago(20) });
  addRequest({ token: 'tokClickedAAAAAA', sent_at: ago(5), clicked_at: ago(4) });
  addRequest({ token: 'tokRemindedAAAAA', sent_at: ago(6), reminder_sent_at: ago(1) });
  addRequest({ token: null, sent_at: ago(5) }); // sent before tracking existed
  addRequest({ token: 'tokHeldAAAAAAAAA', status: 'held', sent_at: null });
  const ids = remindersDue(now).map((r: any) => r.id);
  assert.deepEqual(ids, [due]);
});

test('dailySent counts reminders sent today toward the cap', () => {
  const now = new Date();
  const before = dailySent(now);
  addRequest({ token: 'tokCapAAAAAAAAAA', sent_at: new Date(now.getTime() - 10 * DAY).toISOString(), reminder_sent_at: now.toISOString() });
  assert.equal(dailySent(now), before + 1);
});

test('a queued request carries a tracked link and names the tech', async () => {
  db.prepare(`INSERT INTO review_targets (office_id, office_name, review_url, active) VALUES ('off1', '1st FP Waco LLC', 'https://g.page/r/WACO/review', 1)`).run();
  db.prepare(
    `INSERT INTO crm_jobs (st_id, status, completed_at, source, office_id, office_name, contact_name, contact_email)
     VALUES ('st-900', 'Completed', ?, 'servicetrade', 'off1', '1st FP Waco LLC', 'Dana Lee', 'dana@example.com')`
  ).run(new Date().toISOString());
  db.prepare(`INSERT INTO job_techs (job_st_id, tech_names) VALUES ('st-900', '["Marcus Smith"]')`).run();
  setMode('auto');

  const out = await runReviewSweep();
  assert.equal(out.queued, 1);
  const r = db.prepare(`SELECT token, subject, body, html, tech_names, review_url, status FROM review_requests WHERE recipient_email = 'dana@example.com'`).get() as any;
  assert.match(r.token, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(r.status, 'approved');
  assert.equal(r.subject, 'How did Marcus do on your recent service?');
  assert.ok(r.body.includes(`https://os.example.com/r/${r.token}`));
  assert.ok(r.html.includes(`https://os.example.com/r/${r.token}`));
  assert.ok(!r.html.includes('g.page/r/WACO'), 'the email links through the tracker, not straight to Google');
  assert.equal(r.review_url, 'https://g.page/r/WACO/review');
  assert.equal(recordClick(r.token, { userAgent: 'x' }).url, 'https://g.page/r/WACO/review');
});
