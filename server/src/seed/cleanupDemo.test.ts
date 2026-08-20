import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Production mode so the cleanup actually runs; a private DB so nothing real is touched.
process.env.DEMO_MODE = 'off';
process.env.DB_PATH = path.join(os.tmpdir(), `os-cleanup-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb, getState } from '../db/schema';
import { cleanupDemoData } from './cleanupDemo';

initDb();
const db = getDb();
db.exec(`DELETE FROM onboarding_requests; DELETE FROM onboarding_items; DELETE FROM approvals;`);

// Two onboarding requests: a fixture (reserved .example email) and a real hire (@gmail.com).
const fixtureReq = db
  .prepare(`INSERT INTO onboarding_requests (name, personal_email, job_position) VALUES (?, ?, ?)`)
  .run('Sofia Ramos', 'sofia.ramos@gmail.example', 'CAD Designer').lastInsertRowid as number;
const realReq = db
  .prepare(`INSERT INTO onboarding_requests (name, personal_email, job_position) VALUES (?, ?, ?)`)
  .run('Dana Cole', 'dana.cole@gmail.com', 'Inspector').lastInsertRowid as number;
db.prepare(`INSERT INTO onboarding_items (request_id, owner, owner_label, kind, label) VALUES (?, 'it', 'IT', 'task', 'Laptop')`).run(fixtureReq);
db.prepare(`INSERT INTO onboarding_items (request_id, owner, owner_label, kind, label) VALUES (?, 'it', 'IT', 'task', 'Laptop')`).run(realReq);

// Three approvals: two fixtures (a .example address, the retired brand) and one real one.
db.prepare(`INSERT INTO approvals (agent_key, kind, risk, title, stake, body, trail, subject_type, status) VALUES (?,?,?,?,?,?,?,?, 'pending')`)
  .run('invoices', 'send_email', 'sensitive', 'Final notice to Maplewood', '$34,800', 'Goes to marcy.d@maplewood.example', 'AP inbox', 'invoice');
db.prepare(`INSERT INTO approvals (agent_key, kind, risk, title, stake, body, trail, subject_type, status) VALUES (?,?,?,?,?,?,?,?, 'pending')`)
  .run('invoices', 'send_sms', 'routine', 'Reminder to Stone Oak', '$18,400', 'Hi - heads up. - Northstar Fire & Safety', 'SMS to billing', 'invoice');
db.prepare(`INSERT INTO approvals (agent_key, kind, risk, title, stake, body, trail, subject_type, status) VALUES (?,?,?,?,?,?,?,?, 'pending')`)
  .run('invoices', 'send_email', 'sensitive', 'Real notice to Acme Corp', '$9,000', 'Goes to ap@acmecorp.com', 'AP inbox', 'invoice');

test('cleanup removes only fixture onboarding requests, keeping real hires', () => {
  cleanupDemoData();
  const names = (db.prepare(`SELECT name FROM onboarding_requests ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(names, ['Dana Cole'], 'only the real hire remains');
  const fixtureItems = db.prepare(`SELECT COUNT(*) AS c FROM onboarding_items WHERE request_id = ?`).get(fixtureReq) as { c: number };
  assert.equal(fixtureItems.c, 0, 'fixture items removed');
  const realItems = db.prepare(`SELECT COUNT(*) AS c FROM onboarding_items WHERE request_id = ?`).get(realReq) as { c: number };
  assert.equal(realItems.c, 1, 'real items kept');
});

test('cleanup removes only fixture approvals, keeping real ones', () => {
  const titles = (db.prepare(`SELECT title FROM approvals ORDER BY title`).all() as { title: string }[]).map((r) => r.title);
  assert.deepEqual(titles, ['Real notice to Acme Corp'], 'only the real approval remains');
});

test('cleanup is idempotent: a second run changes nothing and the flag is set', () => {
  assert.equal(getState('cleaned_demo_prod_v1'), '1', 'flag recorded');
  // Re-insert a fixture; because the flag is set, a second run must not touch it.
  db.prepare(`INSERT INTO onboarding_requests (name, personal_email) VALUES ('Late Fixture', 'x@y.example')`).run();
  cleanupDemoData();
  const late = db.prepare(`SELECT COUNT(*) AS c FROM onboarding_requests WHERE name = 'Late Fixture'`).get() as { c: number };
  assert.equal(late.c, 1, 'second run is a no-op once the flag is set');
});
