import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-exceptions-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { OsContext } from './scope';
import { detectExceptions, listExceptions, setExceptionStatus } from './exceptions';

initDb(); // build the real schema (deficiencies, employees, employee_access, invoices, exceptions)
const db = getDb();
db.exec(`DELETE FROM deficiencies; DELETE FROM employees; DELETE FROM employee_access; DELETE FROM invoices; DELETE FROM exceptions;`);

// Austin: 2 aged unquoted deficiencies. Houston: 1 aged unquoted.
const d = db.prepare(`INSERT INTO deficiencies (st_id, office, status, quoted, reported_at, source) VALUES (?,?,?,?,?,?)`);
d.run('a1', '1st FP Austin, LLC (AUS)', 'open', 0, '2020-01-01', 'servicetrade');
d.run('a2', 'Austin', 'open', 0, '2020-01-01', 'servicetrade');
d.run('h1', '1st FP Houston, LLC (HOU)', 'open', 0, '2020-01-01', 'servicetrade');

// A terminated employee (Houston) who still has provisioned access.
const empInfo = db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, office, employment_status) VALUES (?,?,?,?)`).run('Jane', 'Gone', 'Houston', 'terminated');
const empId = Number(empInfo.lastInsertRowid);
db.prepare(`INSERT INTO employee_access (employee_id, system, status) VALUES (?, 'm365', 'provisioned')`).run(empId);

// AR over 90 days (company-wide).
db.prepare(`INSERT INTO invoices (customer, amount, status, due_at) VALUES ('ACME', 120000, 'open', '2020-01-01')`).run();

const ctx = (over: Partial<OsContext>): OsContext => ({ user: null, email: null, roles: [], allOffices: false, offices: [], legacy: false, ...over });
const exec = ctx({ allOffices: true });
const houston = ctx({ offices: ['houston'] });

test('detection creates one deficiency_aging exception per office, plus terminated-access and AR', () => {
  detectExceptions();
  const all = listExceptions(exec, { status: 'open' });
  const cats = all.map((e) => e.category).sort();
  assert.ok(cats.includes('deficiency_aging'));
  assert.ok(cats.includes('terminated_access'));
  assert.ok(cats.includes('ar_aging'));
  const austin = all.find((e) => e.category === 'deficiency_aging' && e.office === 'austin');
  assert.ok(austin);
  assert.equal(austin.count, 2);
  assert.equal(austin.financial_impact, 2 * 650); // projected
  assert.equal(austin.financial_projected, 1);
});

test('detection is idempotent — re-running does not duplicate', () => {
  const before = listExceptions(exec, { status: 'open' }).length;
  detectExceptions();
  detectExceptions();
  const after = listExceptions(exec, { status: 'open' }).length;
  assert.equal(after, before);
});

test('a scoped caller sees only their office plus company-wide exceptions', () => {
  const rows = listExceptions(houston, { status: 'open' });
  const offices = new Set(rows.map((e) => e.office));
  assert.ok(offices.has('houston'));       // its own
  assert.ok(offices.has(null));            // company-wide AR
  assert.ok(!offices.has('austin'));       // never another office
});

test('a scoped caller cannot resolve another office exception', () => {
  const austin = listExceptions(exec, { status: 'open' }).find((e) => e.office === 'austin');
  const out = setExceptionStatus(houston, austin.id, 'resolved');
  assert.deepEqual(out, { ok: false, error: 'office_forbidden' });
});

test('auto-heals: when the condition clears, the exception auto-resolves', () => {
  db.exec(`DELETE FROM deficiencies WHERE office='1st FP Houston, LLC (HOU)'`); // clear Houston's aged deficiency
  detectExceptions();
  const houstonDef = listExceptions(exec, { status: 'open' }).find((e) => e.category === 'deficiency_aging' && e.office === 'houston');
  assert.equal(houstonDef, undefined); // gone from the open queue
  const resolved = db.prepare(`SELECT status, resolution FROM exceptions WHERE dedupe_key='def_aging:houston'`).get() as any;
  assert.equal(resolved.status, 'resolved');
  assert.match(resolved.resolution, /auto/);
});

test('a user-dismissed exception stays dismissed across re-detection', () => {
  const austin = listExceptions(exec, { status: 'open' }).find((e) => e.office === 'austin' && e.category === 'deficiency_aging');
  setExceptionStatus(exec, austin.id, 'dismissed');
  detectExceptions(); // condition still true, but the user decided
  const still = db.prepare(`SELECT status FROM exceptions WHERE id=?`).get(austin.id) as any;
  assert.equal(still.status, 'dismissed');
});

test('accounting handoff detectors: unattributed jobs (company-wide) + missing contact (per office)', () => {
  db.exec(`DELETE FROM crm_jobs;`);
  // completed 2 days ago (well within the 90-day window); date computed in SQL, not a bound literal
  const jNoOffice = db.prepare(`INSERT INTO crm_jobs (st_id, source, office_name, completed_at, contact_email, contact_phone) VALUES (?, 'servicetrade', NULL, date('now','-2 day'), 'a@b.com', '555')`);
  for (let i = 0; i < 3; i++) jNoOffice.run('u' + i); // 3 completed jobs with NO office
  const jNoContact = db.prepare(`INSERT INTO crm_jobs (st_id, source, office_name, completed_at, contact_email, contact_phone) VALUES (?, 'servicetrade', '1st FP Houston, LLC (HOU)', date('now','-2 day'), NULL, NULL)`);
  for (let i = 0; i < 6; i++) jNoContact.run('h' + i); // 6 Houston jobs with no contact (threshold >=5)
  detectExceptions();
  const open = listExceptions(exec, { status: 'open' });
  const noOffice = open.find((e) => e.category === 'handoff_missing_office');
  assert.ok(noOffice);
  assert.equal(noOffice.count, 3);
  assert.equal(noOffice.office, null);         // company-wide
  assert.equal(noOffice.owner_team, 'accounting');
  const noContact = open.find((e) => e.category === 'handoff_missing_contact' && e.office === 'houston');
  assert.ok(noContact);
  assert.equal(noContact.count, 6);
  assert.equal(noContact.owner_team, 'accounting');
});
