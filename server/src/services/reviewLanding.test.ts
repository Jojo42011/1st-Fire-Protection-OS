import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-review-landing-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { initDb } from '../db/schema';
import { getDb } from '../db/index';
import { recordReviewEvent, reviewPageStats, parseEventBody, officeName, REVIEW_PAGE_URL } from './reviewLanding';
import { setTarget } from './reviewRequests';

initDb();
const db = getDb();

test('the badge page lives on the company website', () => {
  assert.equal(REVIEW_PAGE_URL, 'https://1stfpservices.com/review');
});

test('the website beacon arrives as JSON text and is parsed; junk is rejected, not thrown', () => {
  assert.deepEqual(parseEventBody('{"event":"landing_visit","src":"nfc"}'), { event: 'landing_visit', src: 'nfc' });
  assert.deepEqual(parseEventBody({ event: 'landing_visit' }), { event: 'landing_visit' });
  assert.equal(parseEventBody('not json'), null);
  assert.equal(recordReviewEvent(parseEventBody('not json')), false);
});

test('events are validated before they are stored', () => {
  const n = () => (db.prepare(`SELECT COUNT(*) AS v FROM review_page_events`).get() as { v: number }).v;
  const before = n();
  assert.equal(recordReviewEvent({ event: 'landing_visit', src: 'NFC', badge: 'Marcus.S!', sid: 'abc123' }, 'Mozilla/5.0 (iPhone)'), true);
  assert.equal(recordReviewEvent({ event: 'office_selected', office: 'waco', src: 'nfc' }), true);
  assert.equal(recordReviewEvent({ event: 'review_link_clicked', office: 'waco', src: 'nfc', badge: 'marcuss' }), true);
  assert.equal(recordReviewEvent({ event: 'review_link_clicked', office: '' }), false, 'an office event needs an office');
  assert.equal(recordReviewEvent({ event: 'review_link_clicked', office: '-bad' }), false);
  assert.equal(recordReviewEvent({ event: 'drop table' }), false);
  assert.equal(recordReviewEvent(null), false);
  assert.equal(n(), before + 3);
  const row = db.prepare(`SELECT src, badge, mobile FROM review_page_events WHERE event = 'landing_visit' ORDER BY id DESC LIMIT 1`).get() as any;
  assert.deepEqual(row, { src: 'nfc', badge: 'marcuss', mobile: 1 });
});

test('office names come from the slug, since offices are defined on the website', () => {
  assert.equal(officeName('college-station'), 'College Station');
  assert.equal(officeName('mcallen'), 'McAllen');
  assert.equal(officeName('san-antonio'), 'San Antonio');
});

test('stats roll up visits, picks, and taps through to Google by office and badge', () => {
  const s = reviewPageStats(30);
  assert.equal(s.visits, 1);
  assert.equal(s.nfcVisits, 1);
  assert.equal(s.selected, 1);
  assert.equal(s.clicked, 1);
  assert.deepEqual(s.byOffice, [{ office: 'waco', selected: 1, clicked: 1, name: 'Waco' }]);
  assert.deepEqual(s.byBadge, [{ badge: 'marcuss', visits: 1, clicked: 1 }]);
  assert.equal(s.pageUrl, 'https://1stfpservices.com/review');
});

test('a review link saved without an office name gets it from ServiceTrade, and keeps an existing one', () => {
  db.prepare(`INSERT INTO crm_jobs (st_id, status, source, office_id, office_name) VALUES ('lj1', 'Completed', 'servicetrade', 'lar', '1st FP Laredo, LLC (LAR)')`).run();
  setTarget('lar', null, 'https://g.page/r/LAREDOtest/review');
  const name = () => (db.prepare(`SELECT office_name FROM review_targets WHERE office_id = 'lar'`).get() as any).office_name;
  assert.equal(name(), '1st FP Laredo, LLC (LAR)');
  db.prepare(`UPDATE review_targets SET office_name = 'Laredo (custom)' WHERE office_id = 'lar'`).run();
  setTarget('lar', null, 'https://g.page/r/LAREDOtest2/review');
  assert.equal(name(), 'Laredo (custom)');
});
