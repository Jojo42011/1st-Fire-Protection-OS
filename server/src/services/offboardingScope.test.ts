import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';

process.env.DB_PATH = path.join(os.tmpdir(), `offscope-test-${process.pid}.db`);
process.env.DEMO_MODE = 'off';

import { initDb } from '../db/schema';
import { ownersForRoles, createOffboarding, getOffboarding } from './offboardingAgent';

initDb();

test('ownersForRoles maps each department to its own owner, admins see all', () => {
  assert.deepEqual(ownersForRoles(['it']), ['it']);
  assert.deepEqual(ownersForRoles(['hr']), ['hr']);
  assert.deepEqual(ownersForRoles(['accounting']), ['accounting']);
  assert.deepEqual(ownersForRoles(['manager']), ['manager']);
  assert.equal(ownersForRoles(['people_admin']), null, 'admin sees all');
  assert.equal(ownersForRoles(['executive']), null, 'exec sees all');
  assert.equal(ownersForRoles([]), null, 'legacy / no identity sees all');
});

test('offboarding includes the nine HR tasks and scopes items by department', () => {
  const out = createOffboarding({ name: 'Jane Tech', upn: 'jane@1stfpservices.com', office: 'lubbock', termination_date: '2026-09-15' } as any);
  const id = out.request.id;

  const hrCodes = new Set(['hr_notify_safety', 'hr_vehicle_licensing', 'hr_sage_remove', 'hr_servicetrade_remove', 'hr_bamboo_inactivate', 'hr_empnav_terminate']);
  const hrItems = out.items.filter((i: any) => i.owner === 'hr');
  assert.equal(hrItems.length, 6);
  for (const c of hrCodes) assert.ok(out.items.some((i: any) => i.action_code === c && i.owner === 'hr'), `${c} under HR`);
  // The three device tasks moved to IT.
  for (const c of ['it_receive_devices', 'it_icloud_logoff', 'it_remove_pins']) {
    assert.ok(out.items.some((i: any) => i.action_code === c && i.owner === 'it'), `${c} under IT`);
  }

  // HR viewer sees only HR tasks; IT viewer sees only IT tasks; admin sees everything.
  const hrView = getOffboarding(id, ['hr'])!;
  assert.ok(hrView.items.length === 6 && hrView.items.every((i: any) => i.owner === 'hr'));
  const itView = getOffboarding(id, ['it'])!;
  assert.ok(itView.items.length > 0 && itView.items.every((i: any) => i.owner === 'it'));
  const all = getOffboarding(id, null)!;
  assert.ok(all.items.length >= hrView.items.length + itView.items.length);
});
