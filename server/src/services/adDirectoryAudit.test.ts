import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-ad-directory-test-${process.pid}.db`);

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { ingestInventory } from './adAudit';
import { directoryAudit, ouOffice, ouLabel, formatPhone } from './adDirectoryAudit';

initDb();
const db = getDb();
db.exec(`DELETE FROM employees; DELETE FROM ad_users;`);
const emp = (first: string, last: string, email: string, office: string, phone: string | null, title = 'Inspector') =>
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, office, personal_phone, job_position, employment_status) VALUES (?,?,?,?,?,?, 'active')`)
    .run(first, last, email, office, phone, title);
emp('Ann', 'Austin', 'ann@1stfp.com', '1st FP Austin, LLC', '(512) 555-0101');
emp('Hal', 'Moved', 'hal@1stfp.com', '1st FP Houston, LLC', '7135550102');
emp('Una', 'Users', 'una@1stfp.com', '1st FP Waco, LLC', null);
emp('Tia', 'Teams', 'tia@1stfp.com', '1st FP Austin, LLC', '512-555-0104');
const recent = new Date().toISOString();
ingestInventory([
  { objectGuid: 'g1', sam: 'ann', upn: 'ann@1stfp.com', displayName: 'Ann Austin', title: 'Inspector', enabled: true, ou: 'OU=Users,OU=Austin,DC=corp,DC=local', telephone: '512-312-9768', lastLogon: recent },
  { objectGuid: 'g2', sam: 'hal', upn: 'hal@1stfp.com', displayName: 'Hal Moved', title: 'Tech', enabled: true, ou: 'OU=Users,OU=Austin,DC=corp,DC=local' },
  { objectGuid: 'g3', sam: 'una', upn: 'una@1stfp.com', displayName: 'Una Users', enabled: true, ou: 'CN=Users,DC=corp,DC=local' },
  { objectGuid: 'g4', sam: 'tia', upn: 'tia@1stfp.com', displayName: 'Tia Teams', enabled: true, mobile: '512-555-9999', ou: 'OU=Users,OU=Austin,DC=corp,DC=local' },
  { objectGuid: 'g5', sam: 'scanner', upn: 'scanner@1stfp.com', displayName: 'Scanner', enabled: true, ou: 'OU=Service,DC=corp,DC=local' },
  { objectGuid: 'g6', sam: 'hou1', upn: 'h1@x.com', displayName: 'Other Houston', enabled: true, ou: 'OU=Houston,DC=corp,DC=local' },
]);

test('OU names resolve to offices, leaf first', () => {
  assert.equal(ouOffice('OU=Users,OU=Austin,DC=corp,DC=local'), 'austin');
  assert.equal(ouOffice('OU=HOU,DC=corp,DC=local'), 'houston');
  assert.equal(ouOffice('OU=Service Accounts,DC=corp,DC=local'), null);
  assert.equal(ouLabel('OU=Users,OU=Austin,DC=corp,DC=local'), 'Austin / Users');
  assert.equal(formatPhone('+1 (512) 555-0101'), '512-555-0101');
});

test('flags the wrong office OU and the default container', () => {
  const d = directoryAudit();
  const by = (n: string) => d.people.find((p) => p.name === n)!;
  assert.equal(by('Ann Austin').placement, 'ok');
  assert.equal(by('Hal Moved').placement, 'wrong_office');
  assert.equal(by('Una Users').placement, 'default_container');
  assert.equal(d.counts.unmatched_enabled, 2, 'scanner and the unknown Houston account');
});

test('signature fields: office main line, and Mobile only filled when empty', () => {
  const d = directoryAudit();
  const by = (n: string) => d.people.find((p) => p.name === n)!;
  assert.equal(by('Ann Austin').telephone.ok, true);
  assert.equal(by('Hal Moved').telephone.expected, '346-372-8684');
  assert.equal(by('Hal Moved').mobile.status, 'empty_fill');
  assert.equal(by('Una Users').mobile.status, 'empty_none');
  assert.equal(by('Tia Teams').mobile.status, 'differs');
  assert.equal(by('Ann Austin').description.suggested, 'AD + Email');
  assert.equal(by('Hal Moved').description.suggested, 'Email Only');
  assert.match(d.script, /Set-ADUser -Identity 'hal' -OfficePhone '346-372-8684' -MobilePhone '713-555-0102' -WhatIf:\$preview/);
  assert.doesNotMatch(d.script, /Identity 'tia'[^\n]*MobilePhone/, 'never overwrites a Mobile already set');
  assert.doesNotMatch(d.script, /^Get-ADUser .*Move-ADObject/m, 'moves stay commented out');
});
