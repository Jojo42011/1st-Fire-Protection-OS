import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-review-landing-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { initDb } from '../db/schema';
import { getDb } from '../db/index';
import { resolveOffices, renderReviewPage, recordReviewEvent, reviewPageStats } from './reviewLanding';
import { REVIEW_OFFICES } from '../config/reviewOffices';

initDb();
const db = getDb();

test('every configured office link is a Google review link, and slugs are unique', () => {
  const slugs = new Set(REVIEW_OFFICES.map((o) => o.slug));
  assert.equal(slugs.size, REVIEW_OFFICES.length);
  for (const o of REVIEW_OFFICES) {
    assert.match(o.slug, /^[a-z0-9-]+$/);
    if (o.reviewUrl) assert.match(o.reviewUrl, /^https:\/\/g\.page\/r\/[A-Za-z0-9_-]+\/review$/);
  }
});

test('an office with no configured link falls back to the Review requests mapping, else is hidden', () => {
  assert.ok(!resolveOffices().some((o) => o.slug === 'laredo'), 'hidden while unmapped');
  db.prepare(`INSERT INTO review_targets (office_id, office_name, review_url, active) VALUES ('lar', '1st FP Laredo LLC', 'https://g.page/r/LAREDOtest/review', 1)`).run();
  const laredo = resolveOffices().find((o) => o.slug === 'laredo');
  assert.equal(laredo?.url, 'https://g.page/r/LAREDOtest/review');
});

test('a non-Google link is never rendered', () => {
  const out = resolveOffices([{ slug: 'x', name: 'X', reviewUrl: 'javascript:alert(1)', match: 'x' }, { slug: 'y', name: 'Y', reviewUrl: 'https://evil.example/review', match: 'y' }]);
  assert.deepEqual(out, []);
});

test('the page renders one real link per office, escaped, with no leftover placeholders', () => {
  const html = renderReviewPage([
    { slug: 'austin', name: 'Austin', url: 'https://g.page/r/A/review' },
    { slug: 'waco', name: 'Waco <b>', url: 'https://g.page/r/W/review?x=1&y=2' },
  ], 2026);
  assert.equal((html.match(/class="office"/g) || []).length, 2);
  assert.ok(html.includes('href="https://g.page/r/A/review" data-office="austin"'));
  assert.ok(html.includes('Waco &lt;b&gt;'));
  assert.ok(html.includes('x=1&amp;y=2'));
  assert.ok(!html.includes('<!--OFFICES-->') && !html.includes('<!--YEAR-->'));
  assert.ok(html.includes('How was your experience?'));
  assert.ok(renderReviewPage([], 2026).includes('class="empty"'));
});

test('events are validated before they are stored', () => {
  const n = () => (db.prepare(`SELECT COUNT(*) AS v FROM review_page_events`).get() as { v: number }).v;
  const before = n();
  assert.equal(recordReviewEvent({ event: 'landing_visit', src: 'NFC', badge: 'Marcus.S!', sid: 'abc123' }, 'Mozilla/5.0 (iPhone)'), true);
  assert.equal(recordReviewEvent({ event: 'office_selected', office: 'waco', src: 'nfc' }), true);
  assert.equal(recordReviewEvent({ event: 'review_link_clicked', office: 'waco', src: 'nfc', badge: 'marcuss' }), true);
  assert.equal(recordReviewEvent({ event: 'review_link_clicked', office: 'nowhere' }), false);
  assert.equal(recordReviewEvent({ event: 'drop table' }), false);
  assert.equal(recordReviewEvent(null), false);
  assert.equal(n(), before + 3);
  const row = db.prepare(`SELECT src, badge, mobile FROM review_page_events WHERE event = 'landing_visit' ORDER BY id DESC LIMIT 1`).get() as any;
  assert.deepEqual(row, { src: 'nfc', badge: 'marcuss', mobile: 1 });
});

test('stats roll up visits, picks, and taps through to Google by office and badge', () => {
  const s = reviewPageStats(30);
  assert.equal(s.visits, 1);
  assert.equal(s.nfcVisits, 1);
  assert.equal(s.selected, 1);
  assert.equal(s.clicked, 1);
  assert.deepEqual(s.byOffice, [{ office: 'waco', selected: 1, clicked: 1, name: 'Waco' }]);
  assert.deepEqual(s.byBadge, [{ badge: 'marcuss', visits: 1, clicked: 1 }]);
});
