import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-catalog-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { seedOnboardingCatalog, catalogByKind, addCatalogItem, updateCatalogItem, removeCatalogItem } from './onboardingCatalog';
import { getFormOptions } from './onboardingAgent';

initDb();
getDb().exec(`DELETE FROM onboarding_catalog;`);
seedOnboardingCatalog();

test('seed produces model-independent computers and includes Napco in software', () => {
  const computers = catalogByKind('computer');
  assert.ok(computers.length >= 3, 'three computer tiers');
  assert.ok(!computers.some((c) => /T16|P16/.test(c.spec || '')), 'no computer is bound to a specific laptop model');
  const software = catalogByKind('software').map((s) => s.name);
  assert.ok(software.includes('Napco'), 'Napco is offered');
  assert.ok(software.includes('Bluebeam'), 'existing software kept');
});

test('getFormOptions renders the catalog: computers keyed by id, approvals flagged', () => {
  const opts = getFormOptions();
  const bluebeam = opts.software.find((s: any) => s.name === 'Bluebeam')!;
  assert.equal(bluebeam.kind, 'approval', 'Bluebeam needs an owner approval');
  const napco = opts.software.find((s: any) => s.name === 'Napco')!;
  assert.equal(napco.kind, 'task', 'Napco is a plain IT task');
  assert.ok(opts.computers.every((c: any) => /^\d+$/.test(c.key)), 'computer keys are catalog ids');
});

test('add, edit, and remove flow', () => {
  const added = addCatalogItem({ kind: 'software', name: 'DMP Remote Link', owner: 'it' })!;
  assert.ok(added.id > 0);
  assert.ok(catalogByKind('software').some((s) => s.name === 'DMP Remote Link'));
  const edited = updateCatalogItem(added.id, { approval: true, owner: 'mario' })!;
  assert.equal(edited.approval, true);
  assert.equal(edited.owner, 'mario');
  assert.equal(removeCatalogItem(added.id), true);
  assert.ok(!catalogByKind('software').some((s) => s.name === 'DMP Remote Link'), 'removed item is hidden');
});

test('addCatalogItem rejects an unknown kind or empty name', () => {
  assert.equal(addCatalogItem({ kind: 'nonsense', name: 'x' }), null);
  assert.equal(addCatalogItem({ kind: 'software', name: '   ' }), null);
});
