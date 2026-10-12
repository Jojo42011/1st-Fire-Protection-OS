import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-spcov-test-${process.pid}.db`);

import { initDb, setState } from '../db/schema';
import { groupKey, foldersByGroup, includesMap, dropIncluded, CoverageData } from './spCoverage';

initDb();

// Accounting is granted at the drive root, so every office folder inherits it; Austin only opens Austin.
const grants = [
  { drive: 'Documents', folder: 'Austin', grants: [{ kind: 'group', name: 'SG-SP-Accounting' }, { kind: 'group', name: 'SG-SP-Austin' }] },
  { drive: 'Documents', folder: 'Houston', grants: [{ kind: 'group', name: 'SG-SP-Accounting' }, { kind: 'group', name: 'SG-SP-Houston' }] },
  { drive: 'Documents', folder: 'Payroll', grants: [{ kind: 'group', name: 'SG-SP-Accounting' }, { kind: 'group', name: 'SG-SP-Payroll' }, { kind: 'user', name: 'Some One' }] },
  { drive: 'Documents', folder: 'HR', grants: [{ kind: 'group', name: 'SG-SP-HR' }] },
];
const { folders, names } = foldersByGroup(grants);
const data: CoverageData = { at: '2026-10-12T00:00:00Z', site: 'x', folders, names };

test('group names line up however they are written', () => {
  assert.equal(groupKey('SG-SP-Accounting'), 'accounting');
  assert.equal(groupKey('ACCT'), 'accounting');
  assert.equal(groupKey('SG-SP-Management'), groupKey('MGMT'));
});

test('Accounting includes the office and Payroll groups, but not HR; an office group includes nothing', () => {
  const cat = ['SG-SP-Accounting', 'SG-SP-Austin', 'SG-SP-Houston', 'SG-SP-Payroll', 'SG-SP-HR'];
  const inc = includesMap(cat, data);
  assert.deepEqual(inc['SG-SP-Accounting'].sort(), ['SG-SP-Austin', 'SG-SP-Houston', 'SG-SP-Payroll']);
  assert.equal(inc['SG-SP-Austin'], undefined);
  assert.equal(inc['SG-SP-HR'], undefined);
});

test('a request never gets a task for a group another chosen group already opens', () => {
  assert.deepEqual(dropIncluded(['SG-SP-Austin', 'SG-SP-Accounting', 'SG-SP-HR'], data), ['SG-SP-Accounting', 'SG-SP-HR']);
  assert.deepEqual(dropIncluded(['SG-SP-Austin'], null), ['SG-SP-Austin'], 'no data yet: nothing dropped');
});

test('the onboarding request builder drops the included groups', async () => {
  setState('sp_group_coverage', JSON.stringify(data));
  (await import('./onboardingCatalog')).seedOnboardingCatalog();
  const { createRequest } = await import('./onboardingAgent');
  // The seeded catalog uses the short names (ACCT, Austin); they match the SG-SP groups by key.
  const out = createRequest({ name: 'Acct Hire', sharepoint: ['ACCT', 'Austin'] });
  const labels = out.items.map((i: any) => i.label).join(' | ');
  assert.match(labels, /SharePoint group: ACCT/);
  assert.doesNotMatch(labels, /SharePoint group: Austin/);
});
