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
db.exec(`DELETE FROM onboarding_requests; DELETE FROM onboarding_items; DELETE FROM approvals; DELETE FROM license_seats;`);

// Two license seats: a demo one (source 'seed') and a real imported one (source 'graph').
const seedSeat = db
  .prepare(`INSERT INTO license_seats (vendor, product, assignee_name, assignee_email, source) VALUES ('bluebeam','Bluebeam','Jordan Pratt','jordan.pratt@1stfp.example','seed')`)
  .run().lastInsertRowid as number;
const realSeat = db
  .prepare(`INSERT INTO license_seats (vendor, product, assignee_name, assignee_email, source) VALUES ('adobe','Acrobat','Real Person','real@1stfp.com','graph')`)
  .run().lastInsertRowid as number;
// A cancel_seat approval about each seat.
db.prepare(`INSERT INTO approvals (agent_key, kind, risk, title, stake, body, trail, subject_type, subject_id, status) VALUES ('licenses','cancel_seat','sensitive','Cancel the Bluebeam seat for Jordan Pratt','saves $1,752/yr','x','y','seat',?, 'pending')`).run(seedSeat);
db.prepare(`INSERT INTO approvals (agent_key, kind, risk, title, stake, body, trail, subject_type, subject_id, status) VALUES ('licenses','cancel_seat','sensitive','Cancel the Acrobat seat for Real Person','saves $600/yr','x','y','seat',?, 'pending')`).run(realSeat);

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

test('cleanup removes fixture approvals and demo license seats, keeping real ones', () => {
  const titles = (db.prepare(`SELECT title FROM approvals ORDER BY title`).all() as { title: string }[]).map((r) => r.title);
  assert.deepEqual(titles, ['Cancel the Acrobat seat for Real Person', 'Real notice to Acme Corp'], 'only real approvals remain');
  const seatNames = (db.prepare(`SELECT assignee_name FROM license_seats ORDER BY assignee_name`).all() as { assignee_name: string }[]).map((r) => r.assignee_name);
  assert.deepEqual(seatNames, ['Real Person'], 'only the real imported seat remains');
});

test('cleanup is idempotent: a second run changes nothing and the flag is set', () => {
  assert.equal(getState('cleaned_demo_prod_v3'), '1', 'flag recorded');
  // Re-insert a fixture; because the flag is set, a second run must not touch it.
  db.prepare(`INSERT INTO onboarding_requests (name, personal_email) VALUES ('Late Fixture', 'x@y.example')`).run();
  cleanupDemoData();
  const late = db.prepare(`SELECT COUNT(*) AS c FROM onboarding_requests WHERE name = 'Late Fixture'`).get() as { c: number };
  assert.equal(late.c, 1, 'second run is a no-op once the flag is set');
});
