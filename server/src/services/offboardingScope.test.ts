import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';

process.env.DB_PATH = path.join(os.tmpdir(), `offscope-test-${process.pid}.db`);
process.env.DEMO_MODE = 'off';

import { initDb } from '../db/schema';
import { getDb } from '../db/index';
import { ownersForRoles, createOffboarding, getOffboarding, backfillOffboardingItems, hasDirectory } from './offboardingAgent';

initDb();

test('backfill re-adds newly-defined items to existing requests, without duplicating', () => {
  const out = createOffboarding({ name: 'Old Request', upn: 'old@1stfpservices.com', office: 'lubbock', termination_date: '2026-08-01' } as any);
  const id = out.request.id;
  const db = getDb();
  // Simulate a request created before HR/accounting tasks existed: strip those owners.
  db.prepare(`DELETE FROM offboarding_items WHERE request_id = ? AND owner IN ('hr','accounting')`).run(id);
  const before = getOffboarding(id, null)!;
  assert.equal(before.items.filter((i: any) => i.owner === 'hr' || i.owner === 'accounting').length, 0);

  const r1 = backfillOffboardingItems();
  assert.ok(r1.itemsAdded >= 9, 'the 5 HR + 4 accounting tasks are added back');
  const after = getOffboarding(id, null)!;
  assert.equal(after.items.filter((i: any) => i.owner === 'hr').length, 5);
  assert.equal(after.items.filter((i: any) => i.owner === 'accounting').length, 4);

  // Idempotent: a second run adds nothing for this request.
  const countBefore = getOffboarding(id, null)!.items.length;
  backfillOffboardingItems();
  assert.equal(getOffboarding(id, null)!.items.length, countBefore, 'no duplicates on a second backfill');
});

test('a no-directory person (no AD account, no email) has the account/mailbox steps auto-marked N/A', () => {
  assert.equal(hasDirectory({ upn: null, sam: null, object_guid: null }), false);
  assert.equal(hasDirectory({ upn: 'x@1stfpservices.com' }), true);

  const out = createOffboarding({ name: 'No Account Person', office: 'lubbock', termination_date: '2026-10-01' } as any);
  const items = getOffboarding(out.request.id, null)!.items;
  const status = (c: string) => items.find((i: any) => i.action_code === c)?.status;
  // Account/mailbox/cloud steps are N/A.
  for (const c of ['ad_disable', 'revoke_sessions', 'groups_remove', 'license_remove', 'mbx_shared', 'ad_delete']) {
    assert.equal(status(c), 'na', `${c} is N/A without a directory account`);
  }
  // Physical + other-system tasks still apply.
  for (const c of ['it_receive_devices', 'it_keyfob_collect', 'it_badge_collect', 'hr_bamboo_inactivate', 'acct_card_cancel']) {
    assert.equal(status(c), 'pending', `${c} still applies`);
  }
});

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

  const hrCodes = new Set(['hr_notify_safety', 'hr_vehicle_licensing', 'hr_sage_remove', 'hr_bamboo_inactivate', 'hr_empnav_terminate']);
  const hrItems = out.items.filter((i: any) => i.owner === 'hr');
  assert.equal(hrItems.length, 5);
  for (const c of hrCodes) assert.ok(out.items.some((i: any) => i.action_code === c && i.owner === 'hr'), `${c} under HR`);
  // ServiceTrade removal moved to IT; the device + physical-access tasks are IT.
  for (const c of ['it_receive_devices', 'it_icloud_logoff', 'it_remove_pins', 'it_keyfob_deactivate', 'it_keyfob_collect', 'it_badge_collect', 'hr_servicetrade_remove']) {
    assert.ok(out.items.some((i: any) => i.action_code === c && i.owner === 'it'), `${c} under IT`);
  }

  // Shared-mailbox routing: the notify tasks carry the right email_to.
  const emailOf = (c: string) => out.items.find((i: any) => i.action_code === c)?.email_to;
  assert.equal(emailOf('hr_notify_safety'), 'safety@firstfpservices.com');
  assert.equal(emailOf('hr_vehicle_licensing'), 'safety@firstfpservices.com');
  assert.equal(emailOf('hr_sage_remove'), 'accounting@firstfpservices.com');
  for (const c of ['acct_expense_reconcile', 'acct_card_cancel', 'acct_ap_approver', 'acct_bank_access']) {
    assert.equal(emailOf(c), 'accounting@firstfpservices.com', `${c} notifies accounting`);
  }

  // Accounting has its own tasks now.
  for (const c of ['acct_expense_reconcile', 'acct_card_cancel', 'acct_ap_approver', 'acct_bank_access']) {
    assert.ok(out.items.some((i: any) => i.action_code === c && i.owner === 'accounting'), `${c} under accounting`);
  }

  // Each department viewer sees only its own tasks; admin sees everything.
  const hrView = getOffboarding(id, ['hr'])!;
  assert.ok(hrView.items.length === 5 && hrView.items.every((i: any) => i.owner === 'hr'));
  const itView = getOffboarding(id, ['it'])!;
  assert.ok(itView.items.length > 0 && itView.items.every((i: any) => i.owner === 'it'));
  const acctView = getOffboarding(id, ['accounting'])!;
  assert.ok(acctView.items.length === 4 && acctView.items.every((i: any) => i.owner === 'accounting'));
  const all = getOffboarding(id, null)!;
  assert.ok(all.items.length >= hrView.items.length + itView.items.length);
});
