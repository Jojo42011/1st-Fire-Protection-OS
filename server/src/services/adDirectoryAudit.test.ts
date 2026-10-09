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
  assert.match(d.script, /^Fix-User 'hal' @\{ OfficePhone = '346-372-8684'; MobilePhone = '713-555-0102'; Description = 'Email Only'; Office = 'Houston'; Company = '1st Fire Protection' \}/m);
  assert.match(d.script, /^Fix-User 'una' @\{[^}]*Title = 'Inspector'/m, 'fills a blank Title');
  assert.doesNotMatch(d.script, /^Fix-User 'hal'[^\n]*Title/m, 'never overwrites a Title already set');
  assert.doesNotMatch(d.script, /^Fix-User 'tia'[^\n]*MobilePhone/m, 'never overwrites a Mobile already set');
  assert.match(d.script, /^Fix-User 'ann' @\{[^}]*Description = 'AD \+ Email'/m);
  assert.match(d.script, /^param\(\[switch\]\$Apply\)/m);
});

test('moves only into an OU that already holds active people; the rest are listed for a person', () => {
  emp('Hank', 'Houston', 'hank@1stfp.com', '1st FP Houston, LLC', null);
  emp('Hope', 'Houston', 'hope@1stfp.com', '1st FP Houston, LLC', null);
  ingestInventory([
    { objectGuid: 'g2', sam: 'hal', upn: 'hal@1stfp.com', displayName: 'Hal Moved', title: 'Tech', enabled: true, ou: 'OU=Users,OU=Austin,DC=corp,DC=local' },
    { objectGuid: 'g3', sam: 'una', upn: 'una@1stfp.com', displayName: 'Una Users', enabled: true, ou: 'CN=Users,DC=corp,DC=local' },
    { objectGuid: 'g7', sam: 'hank', upn: 'hank@1stfp.com', displayName: 'Hank Houston', enabled: true, ou: 'OU=Users,OU=Houston,DC=corp,DC=local' },
    { objectGuid: 'g8', sam: 'hope', upn: 'hope@1stfp.com', displayName: 'Hope Houston', enabled: true, ou: 'OU=Users,OU=Houston,DC=corp,DC=local' },
  ]);
  const d = directoryAudit();
  assert.match(d.script, /^Move-User 'hal' 'OU=Users,OU=Houston,DC=corp,DC=local'/m);
  assert.doesNotMatch(d.script, /^Move-User 'una'/m, 'no Waco OU with people in it, so no automatic move');
  assert.match(d.script, /^# {3}Una Users \(Waco\): in Users\. There is no OU for Waco yet\./m);
});

test('a real account is matched by email before an admin account can take the person by name, and skipped accounts are printed', () => {
  db.exec(`DELETE FROM employees`);
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, preferred_name, work_email, office, employment_status) VALUES ('Devonte','Booker','Devon','devon.booker@1stfp.com','1st FP Services, LLC','terminated')`).run();
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, preferred_name, work_email, office, employment_status) VALUES ('Devonte','Booker','Devon','devon.booker@1stfp.com','1st FP Services, LLC','active')`).run();
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, preferred_name, work_email, office, employment_status) VALUES ('Shawn','Flores',NULL,NULL,'1st FP Austin, LLC','active')`).run();
  ingestInventory([
    { objectGuid: 'adm', sam: 'admin.devon', upn: 'admin.devon@corp.local', displayName: 'Devon Booker (Admin)', givenName: 'Devon', surname: 'Booker', enabled: true, ou: 'OU=Admins,DC=corp,DC=local' },
    { objectGuid: 'dev', sam: 'devon.booker', upn: 'devon.booker@1stfp.com', displayName: 'Devon Booker', givenName: 'Devon', surname: 'Booker', enabled: true, ou: 'OU=Services,DC=corp,DC=local' },
    { objectGuid: 'sha', sam: 'sflores', upn: 'sflores@corp.local', displayName: 'Shawn Flores', enabled: true, ou: 'OU=Austin,DC=corp,DC=local' },
  ]);
  const d = directoryAudit();
  const names = d.people.map((p) => p.name).sort();
  assert.deepEqual(names, ['Devon Booker', 'Shawn Flores'], 'active record wins; display name matches when AD has no given/surname');
  assert.equal(d.people.find((p) => p.name === 'Devon Booker')!.sam, 'devon.booker', 'the real account, not the admin one');
  assert.match(d.script, /Write-Host '  Devon Booker \(Admin\) \(admin\.devon\): no match in BambooHR/);
});

test('Office becomes the city, and the distribution lists keep their address and match city or LLC', () => {
  const { officeCity } = require('./officeBranding');
  assert.equal(officeCity('1st FP Austin, LLC'), 'Austin');
  assert.equal(officeCity('1st FP Services, LLC'), 'San Antonio');
  assert.equal(officeCity('1st FP Extinguishers, LLC'), 'Extinguishers', 'shares Buda with Austin, so keeps its own name');
  assert.equal(officeCity('Austin'), 'Austin');
  db.exec(`DELETE FROM employees`);
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, office, employment_status) VALUES ('Sam','Antonio','sam@1stfp.com','1st FP Services, LLC','active')`).run();
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, office, employment_status) VALUES ('Al','Austin','al@1stfp.com','1st FP Austin, LLC','active')`).run();
  ingestInventory([
    { objectGuid: 's1', sam: 'sam', upn: 'sam@1stfp.com', displayName: 'Sam Antonio', enabled: true, office: '1st FP Services, LLC', ou: 'OU=Services,DC=corp,DC=local' },
    { objectGuid: 'a1', sam: 'al', upn: 'al@1stfp.com', displayName: 'Al Austin', enabled: true, office: 'Austin', ou: 'OU=Austin,DC=corp,DC=local' },
  ]);
  const d = directoryAudit();
  assert.match(d.script, /^Fix-User 'sam' @\{[^}]*Office = 'San Antonio'; Company = '1st Fire Protection'/m);
  assert.doesNotMatch(d.script, /^Fix-User 'al'[^\n]*Office =/m, 'already the city');
  const plan = require('./distributionLists').buildOfficeDlPlan();
  const sa = plan.offices.find((o: any) => o.office === 'San Antonio');
  assert.ok(sa, 'grouped by city');
  assert.match(plan.ddgScript, /Name = 'San Antonio - All Staff'; Alias = 'services'; Smtp = 'services@1stfpservices\.com'/, 'keeps the existing address');
  assert.match(plan.ddgScript, /\(Office -eq ''San Antonio'' -or Office -eq ''1st FP Services, LLC''\)/, 'matches the city and the old LLC text');
  assert.match(plan.backfillScript, /-Office 'San Antonio' -Company '1st Fire Protection'/);
});

test('a sub-OU of the mapped OU counts as the right place', () => {
  const { setAdSettings } = require('./adProvision');
  db.exec(`DELETE FROM employees`);
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, office, department, employment_status) VALUES ('Rita','Acct','rita@1stfp.com','1st FP Sprinkler Companies, LLC','MGMT','active')`).run();
  db.prepare(`INSERT INTO employees (legal_first_name, legal_last_name, work_email, office, department, employment_status) VALUES ('Ian','Sa','ian@1stfp.com','1st FP Sprinkler Companies, LLC','MGMT','active')`).run();
  setAdSettings({ departmentOuMap: { MGMT: 'OU=MGMT,OU=USERS,OU=1FP,DC=corp,DC=local' } });
  ingestInventory([
    { objectGuid: 'r1', sam: 'rita', upn: 'rita@1stfp.com', displayName: 'Rita Acct', enabled: true, ou: 'OU=ACCOUNTING,OU=MGMT,OU=USERS,OU=1FP,DC=corp,DC=local' },
    { objectGuid: 'i1', sam: 'ian', upn: 'ian@1stfp.com', displayName: 'Ian Sa', enabled: true, ou: 'OU=SA-FP SERVICES,OU=USERS,OU=1FP,DC=corp,DC=local' },
  ]);
  const d = directoryAudit();
  assert.equal(d.people.find((p) => p.name === 'Rita Acct')!.placement, 'ok', 'MGMT / ACCOUNTING is inside MGMT');
  const ian = d.people.find((p) => p.name === 'Ian Sa')!;
  assert.equal(ian.placement, 'not_mapped_ou');
  assert.match(ian.placementNote!, /Department "MGMT" is mapped to 1FP \/ USERS \/ MGMT/);
  setAdSettings({ departmentOuMap: {} });
});
