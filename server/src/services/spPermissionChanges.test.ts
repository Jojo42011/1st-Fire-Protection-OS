import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-spperm-test-${process.pid}.db`);
process.env.MS_GRAPH_TOKEN = 'test-token';

import { initDb, setState } from '../db/schema';
import { applyOct2026SpChanges } from './spPermissionChanges';

initDb();
// Accounting opens Austin and San Antonio (Services); so do their own groups.
setState('sp_group_coverage', JSON.stringify({ at: 'x', site: 'x', names: {}, folders: {
  accounting: ['Documents/1st FP Austin', 'Documents/1st FP Services', 'Documents/Accounting'],
  austin: ['Documents/1st FP Austin'], sanantonio: ['Documents/1st FP Services'],
} }));
const MEMBERS: Record<string, { displayName: string; userPrincipalName: string }[]> = {
  'SG-SP-Services': [{ displayName: 'Only Services', userPrincipalName: 'only@x.com' }, { displayName: 'Both', userPrincipalName: 'both@x.com' }, { displayName: 'Lisa Acct', userPrincipalName: 'lisa@x.com' }],
  'SG-SP-SanAntonio': [{ displayName: 'Both', userPrincipalName: 'both@x.com' }],
  'SG-SP-Accounting': [{ displayName: 'Lisa Acct', userPrincipalName: 'lisa@x.com' }],
  'SG-SP-Austin': [{ displayName: 'Lisa Acct', userPrincipalName: 'lisa@x.com' }],
};

const folders: Record<string, { id: string; perms: any[] }> = {
  '1st FP Houston': { id: 'hou', perms: [{ id: 'p-hr', roles: ['write'], grantedToV2: { group: { displayName: 'SG-SP-HR' } } }, { id: 'p-hou', roles: ['write'], grantedToV2: { group: { displayName: 'SG-SP-Houston' } } }] },
  '1st FP College Station': { id: 'cst', perms: [] },
  '1st FP Lubbock': { id: 'lub', perms: [{ id: 'p-pay', roles: ['write'], grantedToV2: { group: { displayName: 'SG-SP-Payroll' } } }] },
  '1st FP Austin': { id: 'aus', perms: [{ id: 'p-pay2', roles: ['write'], grantedToV2: { group: { displayName: 'SG-SP-Payroll' } } }, { id: 'p-saf', roles: ['write'], grantedToV2: { group: { displayName: 'SG-SP-Safety' } } }] },
  Safety: { id: 'saf', perms: [] },
};
const SUB: Record<string, any[]> = { aus: [{ id: 'ins', name: 'Insurance', folder: {}, webUrl: 'https://1stfp.sharepoint.com/sites/Shared/Documents/1st FP Austin/Insurance' }] };
const SUBPERMS: Record<string, any[]> = { ins: [{ id: 'p-ins', roles: ['read'], grantedToV2: { group: { displayName: 'SG-SP-1AutoInsurance' } } }] };
let writes: string[] = [];
(globalThis as any).fetch = async (url: string, init: any = {}) => {
  const m = (init.method || 'GET').toUpperCase();
  const json = (j: any) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j), headers: { get: () => null } });
  if (m !== 'GET') { writes.push(`${m} ${url.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '')}`); return json({}); }
  if (/\/sites\/[^/]+:\/sites\/Shared\?/.test(url)) return json({ id: 'site1' });
  if (/\/sites\/site1\/drives/.test(url)) return json({ value: [{ id: 'd1', name: 'Documents' }] });
  if (/\/drives\/d1\/root\/children/.test(url)) return json({ value: Object.entries(folders).map(([name, f]) => ({ id: f.id, name, folder: {} })) });
  const ch = /\/drives\/d1\/items\/([a-z]+)\/children/.exec(url);
  if (ch) return json({ value: SUB[ch[1]] || [] });
  const pm = /\/drives\/d1\/items\/([a-z]+)\/permissions/.exec(url);
  if (pm) return json({ value: SUBPERMS[pm[1]] || (Object.values(folders).find((f) => f.id === pm[1]) || { perms: [] }).perms });
  const dec = decodeURIComponent(url);
  if (/startswith\(displayName,'SG-SP'\)/.test(dec)) return json({ value: Object.keys(MEMBERS).map((n) => ({ id: 'g-' + n, displayName: n })) });
  if (/\/groups\?\$filter=/.test(url)) { const n = dec.match(/displayName eq '([^']+)'/)![1]; return json({ value: [{ id: 'g-' + n, displayName: n }] }); }
  const mm = /\/groups\/g-([^/]+)\/members/.exec(dec);
  if (mm) return json({ value: MEMBERS[mm[1]] || [] });
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'nf', headers: { get: () => null } };
};

test('preview changes nothing and says what it would do', async () => {
  writes = [];
  const r = await applyOct2026SpChanges(false, 'https://1stfp.sharepoint.com/sites/Shared/', 'services');
  assert.equal(r.ok, true);
  assert.deepEqual(writes, [], 'no writes in a preview');
  assert.ok(r.lines.some((l) => /HR: would be removed from 1st FP Houston/.test(l)));
  assert.ok(r.lines.some((l) => /Payroll: would be added to 1st FP Houston/.test(l)));
  assert.ok(r.lines.some((l) => /Payroll: already opens 1st FP Lubbock/.test(l)));
  assert.ok(r.lines.some((l) => /Safety: would be added to 1st FP Houston \(edit/.test(l)));
  assert.ok(r.lines.some((l) => /Safety: already opens 1st FP Austin/.test(l)));
  assert.ok(!r.lines.some((l) => /Safety: .*added to Safety$/.test(l)), 'only office folders, not the Safety folder itself');
  const r2 = await applyOct2026SpChanges(false, 'https://1stfp.sharepoint.com/sites/Shared/', 'sanantonio');
  assert.deepEqual(r2.servicesOnly.map((m) => m.upn), ['only@x.com'], 'keeping SanAntonio: move the Services-only member first');
  assert.deepEqual((r2.alreadyCovered || []).map((m) => m.upn), ['lisa@x.com'], 'Accounting staff already open the folder: not added');
  assert.equal(r2.retire, 'SG-SP-Services');
  assert.deepEqual((r2.redundant || []).map((m) => `${m.upn}:${m.group}<${m.via}`), ['lisa@x.com:SG-SP-Austin<SG-SP-Accounting'], 'Austin is redundant next to Accounting');
  assert.equal((r2.deep || [])[0].path, 'Documents/1st FP Austin/Insurance', 'finds where 1Auto Insurance is granted, below the top level');
  assert.match((r2.deep || [])[0].url || '', /Insurance$/);
});

test('apply removes only HR from Houston and adds Payroll and Safety only where they are missing', async () => {
  writes = [];
  const r = await applyOct2026SpChanges(true, 'https://1stfp.sharepoint.com/sites/Shared/');
  assert.equal(r.applied, true);
  assert.ok(writes.includes('DELETE /drives/d1/items/hou/permissions/p-hr'), 'HR grant removed');
  assert.ok(!writes.some((w) => /p-hou/.test(w)), 'the Houston group itself is untouched');
  const invites = writes.filter((w) => /\/invite$/.test(w)).sort();
  assert.deepEqual(invites, ['POST /drives/d1/items/cst/invite', 'POST /drives/d1/items/cst/invite', 'POST /drives/d1/items/hou/invite', 'POST /drives/d1/items/hou/invite', 'POST /drives/d1/items/lub/invite'],
    'Payroll added to Houston and College Station (Lubbock already had it); Safety added to College Station, Houston and Lubbock (Austin already had it)');
});
