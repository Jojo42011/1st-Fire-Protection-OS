import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskScope, seesOnboardingItem, seesOffboardingItem, seesNothing } from './taskScope';

const user = (roles: string[], email = 'pat@1stfpservices.com') => ({ email, display_name: null, roles: roles as any, active: true, source: 'test', offices: [], all_offices: false });

test('no identity or no role sees no tasks at all', () => {
  assert.equal(seesNothing(taskScope(null)), true);
  assert.equal(seesNothing(taskScope(user([]))), true);
  assert.equal(seesOnboardingItem(taskScope(null), { owner: 'it' }), false);
});

test('admins and executives see everything', () => {
  for (const r of ['people_admin', 'executive', 'executive_approver']) {
    const s = taskScope(user([r]));
    assert.equal(seesOnboardingItem(s, { owner: 'rebecca' }), true);
    assert.equal(seesOffboardingItem(s, { owner: 'hr' }, null), true);
  }
});

test('each department sees only its own onboarding lanes', () => {
  const hr = taskScope(user(['hr']));
  assert.equal(seesOnboardingItem(hr, { owner: 'sandi' }), true);
  assert.equal(seesOnboardingItem(hr, { owner: 'bamboo' }), true);
  assert.equal(seesOnboardingItem(hr, { owner: 'it' }), false);
  assert.equal(seesOnboardingItem(hr, { owner: 'rebecca' }), false);
  const acct = taskScope(user(['accounting']));
  assert.equal(seesOnboardingItem(acct, { owner: 'rebecca' }), true);
  assert.equal(seesOnboardingItem(acct, { owner: 'sandi' }), false);
  const safety = taskScope(user(['safety']));
  assert.equal(seesOnboardingItem(safety, { owner: 'denise' }), true);
  assert.equal(seesOnboardingItem(safety, { owner: 'it' }), false);
});

test('each department sees only its own offboarding steps, including Safety', () => {
  const safety = taskScope(user(['safety']));
  assert.equal(seesOffboardingItem(safety, { owner: 'hr', email_to: 'safety@1stfpservices.com' }, null), true);
  assert.equal(seesOffboardingItem(safety, { owner: 'hr' }, null), false);
  assert.equal(seesOffboardingItem(safety, { owner: 'it' }, null), false);
  const hr = taskScope(user(['hr']));
  assert.equal(seesOffboardingItem(hr, { owner: 'hr' }, null), true);
  assert.equal(seesOffboardingItem(hr, { owner: 'accounting' }, null), false);
  const it = taskScope(user(['it']));
  assert.equal(seesOffboardingItem(it, { owner: 'it', action_code: 'it_receive_devices' }, null), true, 'IT also sees the device steps');
});

test('a manager sees only the approvals and steps addressed to them', () => {
  const m = taskScope(user(['manager'], 'ray@1stfpservices.com'));
  assert.equal(seesOnboardingItem(m, { owner: 'manager', email_to: 'Ray@1stfpservices.com' }), true);
  assert.equal(seesOnboardingItem(m, { owner: 'manager', email_to: 'other@1stfpservices.com' }), false);
  assert.equal(seesOnboardingItem(m, { owner: 'it' }), false);
  assert.equal(seesOffboardingItem(m, { owner: 'manager' }, { manager_email: 'ray@1stfpservices.com' }), true);
  assert.equal(seesOffboardingItem(m, { owner: 'manager' }, { manager_email: 'x@1stfpservices.com' }), false);
});

test('several roles see the union', () => {
  const s = taskScope(user(['hr', 'safety']));
  assert.equal(seesOnboardingItem(s, { owner: 'sandi' }), true);
  assert.equal(seesOnboardingItem(s, { owner: 'denise' }), true);
  assert.equal(seesOnboardingItem(s, { owner: 'it' }), false);
});
