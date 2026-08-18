import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Use an isolated temp DB so the os_office_key UDF and a tiny fixture table are available.
process.env.DB_PATH = path.join(os.tmpdir(), `os-scope-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { OsContext, resolveOffice, canSeeOffice, officeScopeClause, allowedOffices } from './scope';

const db = getDb();
db.exec(`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, office TEXT, amount INTEGER);`);
db.exec(`DELETE FROM t;`);
const ins = db.prepare(`INSERT INTO t (office, amount) VALUES (?, ?)`);
// Rows deliberately span the three value-spaces to prove canonicalization in-query.
ins.run('1st FP Austin, LLC (AUS)', 100);
ins.run('Austin', 50);
ins.run('1st FP Houston, LLC (HOU)', 200);
ins.run('Houston', 70);
ins.run('1st FP McAllen, LLC (MCA)', 300);

// A minimal crm_jobs source so discoverOffices() (used by allowedOffices for company-wide callers)
// has real office strings to canonicalize, mirroring production shape.
db.exec(`CREATE TABLE IF NOT EXISTS crm_jobs (id INTEGER PRIMARY KEY, office_name TEXT, source TEXT);`);
db.exec(`DELETE FROM crm_jobs;`);
const insJob = db.prepare(`INSERT INTO crm_jobs (office_name, source) VALUES (?, 'servicetrade')`);
insJob.run('1st FP Austin, LLC (AUS)');
insJob.run('1st FP Houston, LLC (HOU)');
insJob.run('1st FP McAllen, LLC (MCA)');

const ctx = (over: Partial<OsContext>): OsContext => ({
  user: null, email: 'u@1stfp.test', roles: [], allOffices: false, offices: [], legacy: false, ...over,
});
const houston = ctx({ offices: ['houston'], roles: ['partner'] });
const exec = ctx({ allOffices: true, roles: ['executive'] });
const multi = ctx({ offices: ['houston', 'mcallen'], roles: ['accounting'] });

function sumFor(context: OsContext, resolved: string): number {
  const clause = officeScopeClause('office', context, resolved);
  const row = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM t WHERE ${clause.sql}`).get(...clause.params) as { v: number };
  return row.v;
}

test('a scoped partner cannot resolve another office by asking for it', () => {
  assert.deepEqual(resolveOffice(houston, 'austin'), { error: 'office_forbidden', status: 403 });
  assert.deepEqual(resolveOffice(houston, '1st FP Austin, LLC (AUS)'), { error: 'office_forbidden', status: 403 });
  assert.equal(canSeeOffice(houston, 'austin'), false);
  assert.equal(canSeeOffice(houston, 'houston'), true);
});

test('a single-office partner asking for "all" is pinned to their office', () => {
  assert.deepEqual(resolveOffice(houston, 'all'), { office: 'houston' });
  assert.deepEqual(resolveOffice(houston, ''), { office: 'houston' });
  assert.deepEqual(resolveOffice(houston, 'houston'), { office: 'houston' });
});

test('the SQL clause returns ONLY Houston rows for a Houston partner, across all value-spaces', () => {
  // Both "1st FP Houston, LLC (HOU)" (200) and "Houston" (70) count; Austin/McAllen never do.
  assert.equal(sumFor(houston, 'houston'), 270);
});

test('even a forged "all" cannot widen a scoped caller past their offices', () => {
  // Defense in depth: if a bug ever passed resolved="all" for a scoped user, the clause still
  // restricts to their office set — Austin (150) and McAllen (300) stay invisible.
  assert.equal(sumFor(houston, 'all'), 270);
  assert.equal(sumFor(houston, '__scoped__'), 270);
});

test('a multi-office caller sees exactly their offices, nothing else', () => {
  // Houston (270) + McAllen (300) = 570; Austin (150) excluded.
  assert.equal(sumFor(multi, '__scoped__'), 570);
  assert.deepEqual(resolveOffice(multi, 'mcallen'), { office: 'mcallen' });
  assert.deepEqual(resolveOffice(multi, 'austin'), { error: 'office_forbidden', status: 403 });
});

test('an executive with company scope sees everything and can pick any office', () => {
  assert.equal(sumFor(exec, 'all'), 720); // 150 + 270 + 300
  assert.deepEqual(resolveOffice(exec, 'all'), { office: 'all' });
  assert.deepEqual(resolveOffice(exec, 'austin'), { office: 'austin' });
  assert.equal(sumFor(exec, 'austin'), 150);
});

test('a caller with no office scope leaks no rows', () => {
  const none = ctx({ offices: [] });
  assert.equal(sumFor(none, '__scoped__'), 0);
  assert.deepEqual(resolveOffice(none, 'all'), { error: 'no_office_scope', status: 403 });
});

test('allowedOffices reflects only the caller scope', () => {
  assert.deepEqual(allowedOffices(houston).map((o) => o.key), ['houston']);
  const keys = allowedOffices(exec).map((o) => o.key).sort();
  // exec discovers offices from the fixture table (austin, houston, mcallen)
  assert.ok(keys.includes('austin') && keys.includes('houston') && keys.includes('mcallen'));
});
