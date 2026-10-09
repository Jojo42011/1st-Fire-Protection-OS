import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-mobile-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import {
  normNumber, normPersonName, normDate, unsupportedModel, installmentRemaining, parseAttReport, importAttReport,
  parseWorkbook, importWorkbook, listLines, updateLine, addLineEvent, lineDetail, teamsAudit, setPlanCost, linesCsv,
} from './mobileFleet';
import { isVoicePlan, parseTeamsActivity, activityRange } from './teamsVoice';
import { abmClientAssertion, mapAddigyItem } from './appleDevices';
import { executiveReport, setTeamsVoiceCost, DEFAULT_TEAMS_VOICE_COST } from './mobileReport';

initDb();
const db = getDb();
db.exec(`DELETE FROM employees; DELETE FROM employee_assets; DELETE FROM mobile_lines; DELETE FROM mobile_line_events; DELETE FROM teams_voice_users; DELETE FROM apple_devices;`);
db.prepare(`INSERT INTO employees (id, legal_first_name, legal_last_name, work_email, upn, office, employment_status) VALUES (1,'Joshua','Peña','josh@1stfp.com','josh@1stfp.com','Lubbock','active')`).run();
db.prepare(`INSERT INTO employees (id, legal_first_name, legal_last_name, work_email, upn, office, employment_status) VALUES (2,'Robert','Wilson','rw@1stfp.com','rw@1stfp.com','Lubbock','terminated')`).run();
db.prepare(`INSERT INTO employees (id, legal_first_name, legal_last_name, work_email, upn, office, employment_status) VALUES (3,'Mario','Salinas','mario@1stfp.com','mario@1stfp.com','San Antonio','active')`).run();

const H = '"Last updated date","Billing account number","Billing account name","Wireless number","Wireless user name","Status","Status effective date","Device type","Device IMEI","Device make","Device model","Network IMEI mismatch","Device IMEI (network)","Device make (network)","Device model (network)","Operating system version","SIM Type","SIM number (ICCID)","Rate plan SOC: Name","Group plan SOC: Name","Activation date","Last upgrade date","Upgrade in progress","Contract type","Contract start date","Contract end date","Contract term","Contract status","iPhone upgrade eligibility","Smartphone upgrade eligibility","Early iPhone upgrade eligibility","Monthly installment","Installment pay off","Email address"';
const row = (o: Record<string, string>) => [
  '10/08/2026', o.ban || '287358005879', o.banName || '1ST FP LUBBOCK', o.num, o.user || '1ST FP', o.status || 'Active', '08/19/2025', o.type || 'Phone',
  o.imei || '', 'Apple', o.model || 'iPhone 16e A3212 128GB Black', o.mismatch || 'No', o.netImei || '', '', o.netModel || '', '26.0(22H20)', 'Embedded SIM',
  '8901', 'SDDVRP:Plan Minutes', 'LLGUNLB:Unlimited Your Way for Business', '08/19/2025', o.upg || '', 'No', o.ctype || 'Installment', '08/19/2025',
  o.cend || '08/19/2027', '24', o.cstatus || 'Active', o.elig || '08/19/2027', o.elig || '08/19/2027', 'No', o.inst || '$25.00', '', '',
].map((v) => `"${v}"`).join(',');
const REPORT = [
  H,
  row({ num: '2102400023', imei: '351418494775801' }),                                      // Joshua's phone
  row({ num: '2102400187', type: 'Tablet', imei: '352302615912726', model: 'iPad (A16) 2025 A3355 128GB Silver', ctype: 'No Contract', cstatus: '', inst: '' }),
  row({ num: '8064571112', imei: '355613399920199' }),                                      // Robert (terminated)
  row({ num: '2104226903', imei: '356000000000001', model: 'iPhone XR A1984', ctype: 'Standard', cstatus: 'Complete', inst: '', elig: 'Yes' }), // office says cancelled
  row({ num: '2105555157', type: 'Tablet', imei: '356196188127886', model: 'iPad (A16) 2025 A3355 128GB Silver' }), // spare
  row({ num: '2104222470', imei: '351000000000009', mismatch: 'Yes', netImei: '862826052375172', netModel: 'W7' }), // swapped device
  row({ num: '2104220300', banName: '1ST FP SERVICES SAN ANTONIO', ban: '877398346', imei: '359000000000003', model: 'iPhone 16 Pro A3083 256GB' }),
].join('\n');

test('normalizers', () => {
  assert.equal(normNumber('(210) 240-0023'), '2102400023');
  assert.equal(normNumber('210.300.7683'), '2103007683');
  assert.equal(normNumber('X'), '');
  assert.equal(normPersonName('JOSHUA PEÑA'), 'JOSHUA PENA');
  assert.equal(normPersonName('Roman Davila, Jr'), 'ROMAN DAVILA');
  assert.equal(normDate('8/19/2025'), '2025-08-19');
  assert.equal(normDate('2026-02-25'), '2026-02-25');
  assert.equal(normDate('FOT TRANSFER'), '');
});

test('unsupportedModel flags old devices only', () => {
  for (const m of ['iPhone 8 A1905', 'iPhone XR A1984', 'iPhone 6s A1633', 'iPad 6th Generation A1954', 'iPad 5th Gen with Retina display', 'iPad 6 (A1954)']) assert.equal(unsupportedModel(m), true, m);
  for (const m of ['iPhone 11 A2111', 'iPhone 16e A3212', 'iPad 9th Gen (2021)', 'iPad (A16) 2025', 'iPad 10th Generation', 'iPhone SE (A2275)', 'Galaxy S25']) assert.equal(unsupportedModel(m), false, m);
});

test('installmentRemaining counts whole months left', () => {
  assert.equal(installmentRemaining(25, '2027-08-19', 'Active', '2026-10-08'), 25 * 11);
  assert.equal(installmentRemaining(25, '2025-01-01', 'Complete', '2026-10-08'), 0);
  assert.equal(installmentRemaining(null, '', '', '2026-10-08'), null);
});

test('parseAttReport reads the Premier detail report, preferring the network IMEI after a swap', () => {
  const p = parseAttReport(REPORT);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 7);
  const swapped = p.rows.find((r) => r.number === '2104222470')!;
  assert.equal(swapped.mismatch, true);
  assert.equal(swapped.imei, '862826052375172');
  assert.equal(swapped.attImei, '351000000000009');
  assert.equal(p.rows[0].office, 'lubbock');
  assert.equal(p.rows.find((r) => r.number === '2104220300')!.office, 'services');
  assert.equal(p.rows[1].kind, 'tablet');
  assert.equal(p.rows[0].groupPlan, 'Unlimited Your Way for Business');
  assert.equal(parseAttReport('a,b\n1,2').ok, false);
});

test('AT&T import previews without writing, then commits idempotently with a device per line', () => {
  const prev = importAttReport(REPORT, 'tester', false);
  assert.equal(prev.ok, true);
  assert.equal(prev.created, 7);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM mobile_lines`).get() as any).c, 0);
  const first = importAttReport(REPORT, 'tester', true);
  assert.equal(first.created, 7);
  const again = importAttReport(REPORT, 'tester', true);
  assert.equal(again.updated, 7);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM mobile_lines`).get() as any).c, 7);
  // Phones and tablets get a device asset; nothing is duplicated on re-import.
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM employee_assets WHERE asset_type IN ('company_phone','ipad')`).get() as any).c, 7);
  const l = db.prepare(`SELECT * FROM mobile_lines WHERE number = '2102400023'`).get() as any;
  assert.equal(l.in_latest_report, 1);
  assert.equal(l.office, 'lubbock');
  assert.equal(l.paid_off, 0);
  assert.ok(l.device_balance > 0);
});

const WB = [
  {
    name: 'LUB',
    rows: [
      ['1st FP Services Lubbock', '', '', '', '', '', 'Account Number: 287358005879'],
      ['Employee', 'Phone Number', 'iPad', 'iPhone', 'Model', 'Serial Number', 'IMEI', 'Date of Purchase', 'Paid-Off', 'Balance as of 9/2026', 'Device Passcode', 'Apple ID', 'Apple Password', 'Inactive', 'NOTES'],
      ['JOSHUA PEÑA', '210-240-0187', 'X', '', 'iPad (A16) 2025 - 128GB - Silver', 'LM9XHQQL56', '352302615912726', '8/19/2025', 'X', '0', '3473', 'lubbock.0187@icloud.com', 'Fire3473!', '', ''],
      ['JOSHUA PEÑA', '210-240-0023', '', 'X', 'iPhone 16e - 128GB - Black', 'J4Y0MF4M94', '351418494775801', '8/19/2025', '', '274.99', '3473', 'lubbock.0023@icloud.com', 'Fire2026!', '', 'MARIO USED THIS LINE UPGRADE 12/2024'],
      ['ROBERT WILSON', '806-457-1112', '', 'X', 'iPhone 16e - 128GB - Black', '', '355613399920199', '7/31/2025', '', '249.99', '', '', '', '', ''],
      ['JONATHAN TORRES', '210-422-2470', '', 'X', 'iPhone XR 64GB Black', '', '351000000000009', '', 'X', '0', '', 'jt@gmail.com', 'secret', '', 'employee lost phone'],
      ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['DEVICES AVAILABLE TO USE:'],
      ['UNASSIGNED', '210-555-5157', 'X', '', 'iPad (A16) 2025 - 128GB Silver', '', '356196188127886', '10/8/2025', '', '270.75', '3473', '', '', '', "OSCAR'S OLD IPAD"],
      ['CANCELED LINES:'],
      ['JOE BOND', '210-422-6903', '', 'X', 'iPhone XR A1984', '', '', '', 'X', '0', '', '', '', 'X', 'LINE DISCONNECTED 10/2026'],
      ['First Name: Lub'],
    ],
  },
];

test('parseWorkbook classifies sections and never keeps a password or passcode', () => {
  const rows = parseWorkbook(WB);
  assert.equal(rows.length, 6);
  const json = JSON.stringify(rows);
  for (const secret of ['Fire3473!', 'Fire2026!', 'secret']) assert.ok(!json.includes(secret), `leaked ${secret}`);
  assert.ok(!/"3473"/.test(json), 'leaked the passcode');
  const by = (n: string) => rows.find((r) => r.number === n)!;
  assert.equal(by('2102400187').status, 'assigned');
  assert.equal(by('2102400187').kind, 'tablet');
  assert.equal(by('2105555157').status, 'spare');
  assert.equal(by('2104226903').status, 'cancelled');
  assert.equal(by('2102400023').appleAccount, 'lubbock.0023@icloud.com');
});

test('workbook import matches people, keeps AT&T as the billing truth, and records intent', () => {
  const prev = importWorkbook(WB, 'tester', false);
  assert.equal(prev.ok, true);
  assert.equal(prev.matched, 3); // Joshua x2 (accent-insensitive), Robert
  assert.equal(prev.unmatched, 1); // Jonathan Torres is not on the roster
  const out = importWorkbook(WB, 'tester', true);
  assert.equal(out.committed, true);
  const josh = db.prepare(`SELECT * FROM mobile_lines WHERE number = '2102400023'`).get() as any;
  assert.equal(josh.employee_id, 1);
  const asset = db.prepare(`SELECT * FROM employee_assets WHERE id = ?`).get(josh.device_asset_id) as any;
  assert.equal(asset.employee_id, 1);
  assert.equal(asset.status, 'assigned');
  assert.equal(asset.serial, 'J4Y0MF4M94');
  // The line is on the AT&T report, so AT&T's installment math is kept over the workbook balance.
  assert.notEqual(josh.device_balance, 274.99);
  const joe = db.prepare(`SELECT * FROM mobile_lines WHERE number = '2104226903'`).get() as any;
  assert.equal(joe.status, 'active');
  assert.equal(joe.intent, 'cancel');
  const jt = db.prepare(`SELECT * FROM mobile_lines WHERE number = '2104222470'`).get() as any;
  assert.equal(jt.employee_id, null);
  assert.equal(jt.holder_name, 'JONATHAN TORRES');
  const ev = db.prepare(`SELECT COUNT(*) c FROM mobile_line_events WHERE line_id = ? AND kind = 'upgrade'`).get(josh.id) as any;
  assert.equal(ev.c, 1);
});

test('listLines computes the flags IT acts on', () => {
  const { lines, summary } = listLines();
  const f = (n: string) => lines.find((l) => l.number === n)!.flags.map((x: any) => x.key);
  assert.ok(f('2104226903').includes('still_billing'));
  assert.ok(f('2104226903').includes('too_old'));
  assert.ok(f('2105555157').includes('spare'));
  assert.ok(f('8064571112').includes('termed_holder'));
  assert.ok(f('2104222470').includes('imei_mismatch'));
  assert.ok(f('2104222470').includes('unmatched'));
  assert.ok(f('2104222470').includes('personal_apple_id'));
  assert.ok(!f('2102400187').includes('spare'));
  assert.equal(summary.activeLines, 7);
  assert.ok(summary.cutCandidates >= 3);
});

test('plan costs price every line on that plan', () => {
  setPlanCost('Unlimited Your Way for Business', 40);
  const { lines, summary } = listLines();
  assert.equal(lines[0].monthly_cost, 40);
  assert.equal(summary.monthlyService, 40 * 7);
});

test('reassigning a line moves its device and writes the history', () => {
  const spare = db.prepare(`SELECT id, device_asset_id FROM mobile_lines WHERE number = '2105555157'`).get() as any;
  const d = updateLine(spare.id, { employee_id: 3 }, 'tester');
  assert.equal(d.employee_id, 3);
  assert.equal((db.prepare(`SELECT employee_id, status FROM employee_assets WHERE id = ?`).get(spare.device_asset_id) as any).employee_id, 3);
  addLineEvent(spare.id, { kind: 'upgrade', detail: 'Used this line upgrade for Mario' }, 'tester');
  const kinds = lineDetail(spare.id).events.map((e: any) => e.kind);
  assert.ok(kinds.includes('assigned') && kinds.includes('upgrade'));
  // Saving the form unchanged writes nothing to the history.
  const before = lineDetail(spare.id).events.length;
  const cur = lineDetail(spare.id);
  updateLine(spare.id, { employee_id: 3, monthly_cost: '', intent: '', freeze_until: '', apple_account: cur.apple_account || '', notes: cur.notes || '' }, 'tester');
  assert.equal(lineDetail(spare.id).events.length, before);
  updateLine(spare.id, { monthly_cost: 35 }, 'tester');
  assert.match(lineDetail(spare.id).events[0].detail, /^Updated monthly cost$/);
  assert.throws(() => updateLine(spare.id, { employee_id: 999 }, 'tester'), /employee not found/);
  assert.throws(() => updateLine(spare.id, { intent: 'delete' }, 'tester'), /intent/);
});

test('Teams audit sorts overlap and unused licenses', () => {
  const ins = db.prepare(`INSERT INTO teams_voice_users (upn, display_name, account_enabled, employee_id, has_teams_phone, has_calling_plan, call_count, pstn_calls) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run('josh@1stfp.com', 'Joshua Peña', 1, 1, 1, 0, 0, 0);       // has AT&T phone, never calls on Teams
  ins.run('mario@1stfp.com', 'Mario Salinas', 1, 3, 1, 1, 220, 80); // uses Teams; has no AT&T phone of his own yet
  ins.run('rw@1stfp.com', 'Robert Wilson', 0, 2, 0, 0, null, null); // disabled account, AT&T line still active
  ins.run('frontdesk@1stfp.com', 'Front Desk', 1, null, 1, 1, 0, 0); // shared account, unused
  const a = teamsAudit();
  assert.equal(a.synced, true);
  const cat = (p: string) => a.rows.find((r) => r.person.startsWith(p))!.category;
  assert.equal(cat('Joshua'), 'overlap_unused');
  assert.equal(cat('Robert'), 'disabled');
  assert.equal(cat('Front Desk'), 'unused');
  assert.equal(cat('Mario'), 'teams_only');
  assert.equal(a.rows[0].category, 'disabled'); // worst first
});

test('people with both are split by how often they call outside numbers on Teams', () => {
  const set = (pstn: number, calls: number) => db.prepare(`UPDATE teams_voice_users SET pstn_calls = ?, call_count = ? WHERE upn = 'josh@1stfp.com'`).run(pstn, calls);
  const cat = () => teamsAudit().rows.find((r) => r.person.startsWith('Joshua'))!.category;
  set(2, 40); assert.equal(cat(), 'overlap_light');
  set(9, 40); assert.equal(cat(), 'overlap');
  set(30, 40); assert.equal(cat(), 'overlap_heavy');
  set(0, 0); assert.equal(cat(), 'overlap_unused');
});

test('executive report totals come from the same lines and Teams audit', () => {
  const r = executiveReport();
  assert.equal(r.ok, true);
  const by = (k: string) => r.actions.find((x: any) => x.key === k);
  // Joe Bond's paid-off line still bills; Robert (terminated) and the unassigned 210-422-0300 still owe.
  assert.equal(by('cancel_free').count, 1);
  assert.equal(by('cancel_owing').count, 2);
  assert.ok(by('cancel_owing').oneTime > 0);
  // Joshua (has both, never calls on Teams) + the unused shared Front Desk account.
  assert.equal(by('remove_teams').count, 2);
  assert.equal(by('remove_teams').monthly, 2 * DEFAULT_TEAMS_VOICE_COST);
  assert.equal(r.teamsVoice.estimated, true);
  const sum = r.actions.reduce((s: number, x: any) => s + x.monthly, 0);
  assert.equal(r.total.monthly, Math.round(sum * 100) / 100);
  assert.equal(r.total.yearly, Math.round(sum * 12 * 100) / 100);
  assert.equal(r.idleLines.length, 3);
  assert.equal(r.idleLines[0].balance, 0, 'free-to-cancel lines first');
  setTeamsVoiceCost(20);
  const r2 = executiveReport();
  assert.equal(r2.teamsVoice.estimated, false);
  assert.equal(r2.actions.find((x: any) => x.key === 'remove_teams').monthly, 40);
  assert.throws(() => setTeamsVoiceCost('abc'), /positive number/);
});

test('CSV export has a row per line', () => {
  const csv = linesCsv();
  assert.equal(csv.split('\n').length, 1 + 7);
  assert.ok(!/Fire3473/.test(csv));
});

test('Teams helpers recognize voice plans and the activity report', () => {
  assert.equal(isVoicePlan('MCOEV'), 'phone');
  assert.equal(isVoicePlan('MCOPSTN1'), 'calling_plan');
  assert.equal(isVoicePlan('MCOEV_VIRTUALUSER'), null);
  assert.equal(isVoicePlan('EXCHANGE_S_STANDARD'), null);
  const m = parseTeamsActivity('﻿Report Refresh Date,User Principal Name,Last Activity Date,Call Count,Meeting Count\n2026-10-07,Josh@1stfp.com,2026-10-01,12,3\n');
  assert.deepEqual(m.get('josh@1stfp.com'), { calls: 12, meetings: 3, last: '2026-10-01' });
});

test('the Teams usage report says which days it covers', () => {
  const csv = '﻿Report Refresh Date,User Principal Name,Call Count,Report Period\n2026-10-07,a@1stfp.com,3,90\n';
  assert.deepEqual(activityRange(csv, 'D90'), { from: '2026-07-10', to: '2026-10-07' });
  // No Report Period column: fall back to the period that was asked for.
  assert.deepEqual(activityRange('Report Refresh Date,User Principal Name\n2026-10-07,a@1stfp.com\n', 'D30'), { from: '2026-09-08', to: '2026-10-07' });
  assert.equal(activityRange('User Principal Name\na@1stfp.com\n', 'D90'), null);
});

test('ABM client assertion is a valid ES256 JWT for Apple', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwt = abmClientAssertion({ clientId: 'BUSINESSAPI.abc', keyId: 'KEY1', privateKeyPem: pem, now: 1_760_000_000_000 });
  const [h, p, s] = jwt.split('.');
  const dec = (x: string) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepEqual(dec(h), { alg: 'ES256', kid: 'KEY1', typ: 'JWT' });
  const payload = dec(p);
  assert.equal(payload.iss, 'BUSINESSAPI.abc');
  assert.equal(payload.sub, 'BUSINESSAPI.abc');
  assert.equal(payload.aud, 'https://account.apple.com/auth/oauth2/v2/token');
  assert.ok(payload.exp > payload.iat);
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  assert.equal(ok, true);
});

test('Addigy items map by fact identifier', () => {
  const d = mapAddigyItem({ agentid: 'a1', audit_date: '2026-10-01T00:00:00Z', facts: { serial_number: { value: 'j4y0mf4m94' }, device_model_name: { value: 'iPhone 16e' }, device_name: { value: "Josh's iPhone" } } });
  assert.equal(d!.serial, 'J4Y0MF4M94');
  assert.equal(d!.model, 'iPhone 16e');
  assert.equal(d!.lastOnline, '2026-10-01T00:00:00Z');
  assert.equal(mapAddigyItem({ facts: {} }), null);
});
