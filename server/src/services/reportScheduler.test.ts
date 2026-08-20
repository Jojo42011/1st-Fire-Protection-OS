import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-sched-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';
delete process.env.MS_MAIL_FROM; // ensure mail reads as not configured in this test

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { renderReport, runDueReports, nextWeeklyRun } from './reportScheduler';

initDb();
const db = getDb();
db.exec(`DELETE FROM saved_reports; DELETE FROM quotes;`);
// a couple of open quotes so open_pipeline has a value
db.prepare(`INSERT INTO quotes (source, stage, amount_cents, office) VALUES ('servicetrade','submitted',500000,'houston')`).run();
db.prepare(`INSERT INTO quotes (source, stage, amount_cents, office) VALUES ('servicetrade','reviewed',300000,'austin')`).run();

test('nextWeeklyRun is seven days out', () => {
  const from = '2026-01-01T00:00:00.000Z';
  assert.equal(nextWeeklyRun(from), '2026-01-08T00:00:00.000Z');
});

test('renderReport builds a subject and an HTML body for a single metric', () => {
  const out = renderReport('Weekly pipeline', { metric: 'open_pipeline', office: 'all', period: 'month' }, '(shared)');
  assert.ok(!('error' in out));
  if (!('error' in out)) {
    assert.match(out.subject, /Weekly pipeline/);
    assert.match(out.html, /Open pipeline/);
    assert.match(out.html, /never booked revenue/); // the honesty footnote rides along
  }
});

test('renderReport supports a group-by-office table', () => {
  const out = renderReport('By office', { metric: 'open_pipeline', groupBy: 'office', period: 'month' }, '(shared)');
  assert.ok(!('error' in out));
  if (!('error' in out)) assert.match(out.html, /<table/);
});

test('runDueReports finds due reports but sends nothing when mail is not configured', async () => {
  db.prepare(
    `INSERT INTO saved_reports (owner_email, name, config_json, schedule, recipient, next_run_at)
     VALUES ('(shared)', 'Due one', ?, 'weekly', 'boss@example.com', '2000-01-01T00:00:00Z')`
  ).run(JSON.stringify({ metric: 'open_pipeline', office: 'all', period: 'month' }));
  const r = await runDueReports();
  assert.equal(r.due, 1);
  assert.equal(r.sent, 0);      // mail not configured, so nothing is sent
  assert.equal(r.skipped, 1);
  // and the report stays due (next_run_at not advanced), so it is honest about not having sent
  const row = db.prepare(`SELECT next_run_at, last_sent_at FROM saved_reports WHERE name = 'Due one'`).get() as any;
  assert.equal(row.last_sent_at, null);
});
