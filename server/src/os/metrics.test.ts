import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-metrics-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { OsContext } from '../os/scope';
import { runMetric, metricByOffice } from './metrics';
import { resolvePeriod } from './period';

const db = getDb();
db.exec(`CREATE TABLE IF NOT EXISTS quotes (id INTEGER PRIMARY KEY, office TEXT, source TEXT, stage TEXT, amount_cents INTEGER);`);
db.exec(`CREATE TABLE IF NOT EXISTS deficiencies (id INTEGER PRIMARY KEY, office TEXT, status TEXT, quoted INTEGER, proposed_usd INTEGER);`);
db.exec(`CREATE TABLE IF NOT EXISTS crm_jobs (id INTEGER PRIMARY KEY, office_name TEXT, source TEXT, completed_at TEXT);`);
db.exec(`DELETE FROM quotes; DELETE FROM deficiencies; DELETE FROM crm_jobs;`);

const q = db.prepare(`INSERT INTO quotes (office, source, stage, amount_cents) VALUES (?,?,?,?)`);
// Austin: 1 won, 1 lost, open pipeline $1000
q.run('1st FP Austin, LLC (AUS)', 'servicetrade', 'accepted', 0);
q.run('1st FP Austin, LLC (AUS)', 'servicetrade', 'rejected', 0);
q.run('Austin', 'servicetrade', 'submitted', 100000);
// Houston: 3 won, 1 lost, open pipeline $2000
q.run('1st FP Houston, LLC (HOU)', 'servicetrade', 'won', 0);
q.run('Houston', 'servicetrade', 'approved', 0);
q.run('Houston', 'servicetrade', 'accepted', 0);
q.run('Houston', 'servicetrade', 'lost', 0);
q.run('1st FP Houston, LLC (HOU)', 'servicetrade', 'pending', 200000);

const d = db.prepare(`INSERT INTO deficiencies (office, status, quoted, proposed_usd) VALUES (?,?,?,?)`);
d.run('Houston', 'open', 1, 900);  // quoted, $900
d.run('Houston', 'open', 0, 0);    // unquoted
d.run('Austin', 'open', 0, 0);     // unquoted

const ctx = (over: Partial<OsContext>): OsContext => ({ user: null, email: null, roles: [], allOffices: false, offices: [], legacy: false, ...over });
const houston = ctx({ offices: ['houston'] });
const exec = ctx({ allOffices: true });
const range = resolvePeriod('all');

function val(key: string, c: OsContext, office?: string): number {
  const r = runMetric(key, c, { office, range });
  return 'error' in r ? NaN : r.value;
}

test('a scoped caller is rejected when requesting another office metric', () => {
  const r = runMetric('open_pipeline', houston, { office: 'austin', range });
  assert.deepEqual(r, { error: 'office_forbidden', status: 403 });
});

test('open_pipeline is office-scoped in SQL across value-spaces', () => {
  assert.equal(val('open_pipeline', houston, 'houston'), 2000); // only Houston's $2000
  assert.equal(val('open_pipeline', exec, 'all'), 3000);        // Austin 1000 + Houston 2000
  assert.equal(val('open_pipeline', exec, 'austin'), 1000);
});

test('derived win rate composes won/lost within scope', () => {
  // Houston: 3 won, 1 lost -> 75%
  assert.equal(val('quote_win_rate', houston, 'houston'), 75);
  // Austin: 1 won, 1 lost -> 50%
  assert.equal(val('quote_win_rate', exec, 'austin'), 50);
});

test('repair opportunity = real quoted + projected unquoted, scoped', () => {
  // Houston: quoted $900 + 1 unquoted * 650 = 1550
  assert.equal(val('quoted_repair_value', houston, 'houston'), 900);
  assert.equal(val('projected_repair_opportunity', houston, 'houston'), 650);
  assert.equal(val('repair_opportunity_total', houston, 'houston'), 1550);
});

test('company-wide metric is flagged and not falsely office-scoped', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, amount INTEGER, status TEXT, due_at TEXT);`);
  db.exec(`DELETE FROM invoices;`);
  db.prepare(`INSERT INTO invoices (amount, status, due_at) VALUES (5000,'open','2020-01-01')`).run();
  const r = runMetric('ar_90_plus', houston, { office: 'houston', range });
  assert.ok(!('error' in r));
  if (!('error' in r)) { assert.equal(r.companyWide, true); assert.equal(r.value, 5000); }
});

test('metricByOffice returns only the caller authorized offices', () => {
  const rows = metricByOffice('open_pipeline', houston, { range });
  assert.deepEqual(rows.map((r) => r.office), ['houston']);
  assert.equal(rows[0].value, 2000);
  const all = metricByOffice('open_pipeline', exec, { range });
  const keys = all.map((r) => r.office).sort();
  assert.ok(keys.includes('austin') && keys.includes('houston'));
});
