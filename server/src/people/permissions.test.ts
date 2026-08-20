import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-perms-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { getMatrix, saveRoleLevels, resetRoleLevels, moduleLevel, levelsForRole } from './permissions';
import { canViewCompensation, AppUser } from './authz';

initDb();
getDb().exec(`DELETE FROM role_modules;`);

const user = (roles: string[]): AppUser => ({ email: 'x@y.z', display_name: null, roles: roles as any, active: true, source: 'test', offices: [], all_offices: false });

test('presets are returned for every role, and overrides start empty', () => {
  const m = getMatrix();
  assert.equal(m.modules.length, 9);
  assert.equal(m.roles.hr.levels.comp, 2);
  assert.equal(m.roles.accounting.levels.comp, 0);
  assert.equal(m.roles.accounting.customized, false);
});

test('moduleLevel takes the highest level across a user\'s roles; people_admin is a super-user', () => {
  assert.equal(moduleLevel(user(['accounting']), 'comp'), 0);
  assert.equal(moduleLevel(user(['hr']), 'comp'), 2);
  assert.equal(moduleLevel(user(['accounting', 'hr']), 'comp'), 2); // max wins
  assert.equal(moduleLevel(user(['people_admin']), 'receivables'), 2); // super-user
});

test('compensation visibility is driven by the matrix comp module', () => {
  assert.equal(canViewCompensation(user(['hr'])), true);
  assert.equal(canViewCompensation(user(['accounting'])), false);
  assert.equal(canViewCompensation(user(['it', 'safety'])), false);
  assert.equal(canViewCompensation(user(['people_admin'])), true);
});

test('saving an override changes the effective level and persists; reset restores the preset', () => {
  const saved = saveRoleLevels('accounting', { comp: 1, receivables: 2 }, 'tester');
  assert.equal(saved.comp, 1);
  assert.equal(levelsForRole('accounting').comp, 1);
  assert.equal(getMatrix().roles.accounting.customized, true);
  // now an accounting user can view comp
  assert.equal(canViewCompensation(user(['accounting'])), true);
  // reset clears it
  const back = resetRoleLevels('accounting');
  assert.equal(back.comp, 0);
  assert.equal(canViewCompensation(user(['accounting'])), false);
  assert.equal(getMatrix().roles.accounting.customized, false);
});

test('levels are clamped to 0..2 on save', () => {
  saveRoleLevels('viewer', { comp: 9 as any, overview: -3 as any }, 'tester');
  assert.equal(levelsForRole('viewer').comp, 2);
  assert.equal(levelsForRole('viewer').overview, 0);
  resetRoleLevels('viewer');
});

test('an unknown role is rejected', () => {
  assert.throws(() => saveRoleLevels('not_a_role', { comp: 1 }, 'tester'), /unknown_role/);
});
