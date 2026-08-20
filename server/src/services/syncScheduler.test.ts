import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-syncsched-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { listSchedules, setSchedule, runSyncNow, SYNC_DEFS } from './syncScheduler';

initDb();
getDb().exec(`DELETE FROM sync_schedules;`);

test('listSchedules returns every integration at its coded default cadence', () => {
  const rows = listSchedules();
  assert.equal(rows.length, SYNC_DEFS.length);
  const st = rows.find((r) => r.integration_key === 'servicetrade')!;
  assert.equal(st.interval_minutes, 15, 'ServiceTrade defaults to 15 minutes');
  assert.equal(st.enabled, true);
  assert.equal(st.last_status, 'never');
  const bamboo = rows.find((r) => r.integration_key === 'bamboo')!;
  assert.equal(bamboo.interval_minutes, 60);
});

test('setSchedule persists a new cadence and can pause an integration', () => {
  const updated = setSchedule('servicetrade', { interval_minutes: 30 })!;
  assert.equal(updated.interval_minutes, 30);
  assert.equal(listSchedules().find((r) => r.integration_key === 'servicetrade')!.interval_minutes, 30);
  const paused = setSchedule('bamboo', { enabled: false })!;
  assert.equal(paused.enabled, false);
  assert.equal(paused.next_run_at, null, 'a paused integration has no next run');
});

test('setSchedule rejects an unknown integration', () => {
  assert.equal(setSchedule('nope', { interval_minutes: 5 }), null);
});

test('runSyncNow is keyless-safe: it records a result without throwing', async () => {
  // No BambooHR credentials in the test env, so this is a graceful no-op that still records a run.
  const out = await runSyncNow('bamboo');
  assert.ok(out, 'returns a result');
  const row = listSchedules().find((r) => r.integration_key === 'bamboo')!;
  assert.ok(row.last_run_at, 'last_run_at is stamped');
  assert.notEqual(row.last_status, 'never');
});

test('runSyncNow returns null for an unknown integration', async () => {
  assert.equal(await runSyncNow('nope'), null);
});
