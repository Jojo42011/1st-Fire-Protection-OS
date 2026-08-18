import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRole, canApprove, canViewCompensation, hasAnyPeopleRole, AppUser, Role } from './authz';

const mk = (roles: Role[]): AppUser => ({ email: 'x@1stfp.test', display_name: null, roles, active: true, source: 'test', offices: [], all_offices: false });

test('people_admin is a super-user across roles, approvals and comp', () => {
  const admin = mk(['people_admin']);
  assert.equal(hasRole(admin, 'safety'), true);
  assert.equal(canApprove(admin, 'executive_approver'), true);
  assert.equal(canViewCompensation(admin), true);
});

test('team roles are scoped; only HR sees compensation', () => {
  assert.equal(hasRole(mk(['it']), 'it'), true);
  assert.equal(hasRole(mk(['it']), 'hr'), false);
  assert.equal(canViewCompensation(mk(['it'])), false);
  assert.equal(canViewCompensation(mk(['manager'])), false);
  assert.equal(canViewCompensation(mk(['hr'])), true);
});

test('MGMT approval is satisfied only by an executive_approver (Mario or Chris)', () => {
  assert.equal(canApprove(mk(['executive_approver']), 'executive_approver'), true);
  assert.equal(canApprove(mk(['manager']), 'executive_approver'), false);
  assert.equal(canApprove(mk(['accounting']), 'executive_approver'), false);
});

test('unauthenticated user has no access', () => {
  assert.equal(hasRole(null, 'it'), false);
  assert.equal(canApprove(null, 'hr'), false);
  assert.equal(hasAnyPeopleRole(null), false);
  assert.equal(hasAnyPeopleRole(mk(['viewer'])), true);
});
