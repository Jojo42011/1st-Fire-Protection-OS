// DB-integration test for the lifecycle: onboarding -> dependency unblocking -> activation ->
// offboarding reverse-routing. Uses a throwaway SQLite file (never the real db).
process.env.DB_PATH = `/tmp/people-svc-test-${process.pid}.db`;
process.env.DEMO_MODE = 'off';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initDb } from '../db/schema';
import { getDb } from '../db/index';
import * as svc from './service';

before(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch { /* */ } }
  initDb();
  svc.seedPeopleCatalog();
});

test('job positions + role templates seed as unreviewed config (not demo data)', () => {
  const positions = (getDb().prepare(`SELECT COUNT(*) AS c FROM job_positions`).get() as any).c;
  const unreviewed = (getDb().prepare(`SELECT COUNT(*) AS c FROM role_templates WHERE review_status = 'unreviewed'`).get() as any).c;
  assert.ok(positions >= 50, `expected 50+ positions, got ${positions}`);
  assert.equal(positions, unreviewed, 'every position starts with an unreviewed template');
});

test('onboarding routes tasks; restricted access + vehicle are blocked until their gate clears', () => {
  const { employee_id } = svc.createOnboarding(
    { legal_first_name: 'Jane', legal_last_name: 'Smith', job_position: 'Service Tech', office: 'Austin', manager: 'Boss',
      intake: { companyEmail: true, sharepoint: ['mgmt'], companyVehicle: true, wexCard: true, buildingAccess: ['key_fob'] } },
    'admin@1stfp.test'
  );
  const tasks = svc.listTasks({ employee_id });
  const mgmtAppr = tasks.find((t: any) => t.item_key === 'sp_appr_mgmt');
  const mgmtProv = tasks.find((t: any) => t.item_key === 'sp_it_mgmt');
  const veh = tasks.find((t: any) => t.item_key === 'safety_vehicle');
  const wex = tasks.find((t: any) => t.item_key === 'safety_wex');
  const fob = tasks.find((t: any) => t.item_key === 'access_key_fob');
  assert.equal(mgmtAppr.status, 'awaiting_approval');
  assert.equal(mgmtAppr.approver_role, 'executive_approver');
  assert.equal(mgmtProv.status, 'blocked');
  assert.equal(veh.status, 'blocked');
  assert.equal(veh.team, 'safety');
  assert.equal(wex.team, 'safety');
  assert.equal(fob.team, 'it');

  // Approving the executive gate unblocks the IT provisioning task.
  svc.approveTask(mgmtAppr.id, 'mario@1stfp.test');
  assert.equal(svc.listTasks({ employee_id }).find((t: any) => t.item_key === 'sp_it_mgmt').status, 'pending');

  // MVR clearing unblocks the vehicle assignment (modeled dependency, not memory).
  const mvr = svc.listTasks({ employee_id }).find((t: any) => t.item_key === 'safety_mvr');
  svc.completeTask(mvr.id, 'safety@1stfp.test');
  assert.equal(svc.listTasks({ employee_id }).find((t: any) => t.item_key === 'safety_vehicle').status, 'pending');
});

test('finishing all tasks activates the employee; offboarding reverses the ACTUAL footprint', () => {
  const { employee_id } = svc.createOnboarding(
    { legal_first_name: 'Bob', legal_last_name: 'Jones', job_position: 'Admin',
      intake: { companyEmail: true, systems: ['servicetrade'], wexCard: true, companyVehicle: true } },
    'admin@1stfp.test'
  );
  // Resolve every task (approve approvals, complete actionable tasks) until the queue drains.
  for (let i = 0; i < 60; i++) {
    const open = svc.listTasks({ employee_id, status: 'open' });
    if (!open.length) break;
    for (const t of open) {
      if (t.kind === 'approval') svc.approveTask(t.id, 'exec@1stfp.test');
      else if (t.status !== 'blocked') svc.completeTask(t.id, 'team@1stfp.test');
    }
  }
  assert.equal((getDb().prepare(`SELECT employment_status FROM employees WHERE id = ?`).get(employee_id) as any).employment_status, 'active');
  assert.equal((getDb().prepare(`SELECT status FROM employee_access WHERE employee_id = ? AND system = 'servicetrade'`).get(employee_id) as any).status, 'provisioned');

  const { tasks } = svc.startOffboarding(employee_id, { termination_type: 'voluntary' }, 'hr@1stfp.test');
  assert.ok(tasks >= 3);
  const off = svc.listTasks({ employee_id }).filter((t: any) => t.workflow_kind === 'offboarding');
  assert.ok(off.some((t: any) => /Revoke ServiceTrade/i.test(t.title) && t.team === 'it'), 'revokes ServiceTrade to IT');
  assert.ok(off.some((t: any) => t.asset_type === 'vehicle' && t.team === 'safety'), 'recovers vehicle to Safety');
  assert.ok(off.some((t: any) => t.asset_type === 'wex_card' && t.team === 'safety'), 'recovers WEX to Safety');
  assert.ok(off.some((t: any) => /terminated/i.test(t.title) && t.team === 'hr'), 'HR closeout present');
  assert.equal((getDb().prepare(`SELECT employment_status FROM employees WHERE id = ?`).get(employee_id) as any).employment_status, 'offboarding');
});
