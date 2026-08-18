import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-work-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { OsContext } from './scope';
import { listWork } from './work';
import { detectExceptions } from './exceptions';

initDb();
const db = getDb();
db.exec(`DELETE FROM employees; DELETE FROM people_workflows; DELETE FROM people_tasks; DELETE FROM deficiencies; DELETE FROM invoices; DELETE FROM exceptions;`);

// Two employees with an open onboarding task each, in different offices.
const hou = Number(db.prepare(`INSERT INTO employees (legal_first_name, office, employment_status) VALUES ('Hank','1st FP Houston, LLC (HOU)','onboarding')`).run().lastInsertRowid);
const aus = Number(db.prepare(`INSERT INTO employees (legal_first_name, office, employment_status) VALUES ('Amy','1st FP Austin, LLC (AUS)','onboarding')`).run().lastInsertRowid);
const wf = Number(db.prepare(`INSERT INTO people_workflows (employee_id, kind, status) VALUES (?, 'onboarding','open')`).run(hou).lastInsertRowid);
db.prepare(`INSERT INTO people_tasks (workflow_id, employee_id, team, kind, title, status, assigned_user) VALUES (?,?,?,?,?,?,?)`)
  .run(wf, hou, 'it', 'task', 'Provision laptop', 'pending', 'devon@1stfp.test');
const wf2 = Number(db.prepare(`INSERT INTO people_workflows (employee_id, kind, status) VALUES (?, 'onboarding','open')`).run(aus).lastInsertRowid);
db.prepare(`INSERT INTO people_tasks (workflow_id, employee_id, team, kind, title, status) VALUES (?,?,?,?,?,?)`)
  .run(wf2, aus, 'it', 'task', 'Provision laptop', 'pending');

// An AR exception (company-wide) so Work also aggregates exceptions.
db.prepare(`INSERT INTO invoices (customer, amount, status, due_at) VALUES ('ACME', 200000, 'open', '2020-01-01')`).run();
detectExceptions();

const ctx = (over: Partial<OsContext>): OsContext => ({ user: null, email: null, roles: [], allOffices: false, offices: [], legacy: false, ...over });
const houston = ctx({ offices: ['houston'], email: 'devon@1stfp.test' });
const exec = ctx({ allOffices: true });

test('Work aggregates People tasks + exceptions, normalized', () => {
  const all = listWork(exec);
  assert.ok(all.some((t) => t.source === 'people'));
  assert.ok(all.some((t) => t.source === 'exception'));
  const laptop = all.find((t) => t.subject === 'Provision laptop' && t.office === 'houston');
  assert.ok(laptop);
  assert.equal(laptop!.ownerTeam, 'it');
  assert.equal(laptop!.group, 'needs_you');
});

test('a scoped caller only sees their office People tasks (plus company-wide exceptions)', () => {
  const mineOffices = new Set(listWork(houston).filter((t) => t.source === 'people').map((t) => t.office));
  assert.ok(mineOffices.has('houston'));
  assert.ok(!mineOffices.has('austin')); // never another office's People task
  // company-wide AR exception is still visible
  assert.ok(listWork(houston).some((t) => t.source === 'exception' && t.office === null));
});

test('the "mine" filter narrows to the caller assigned tasks', () => {
  const mine = listWork(houston, { mine: true }).filter((t) => t.source === 'people');
  assert.ok(mine.every((t) => (t.assignedUser || '').toLowerCase() === 'devon@1stfp.test'));
  assert.ok(mine.length >= 1);
});
