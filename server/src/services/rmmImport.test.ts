import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-rmm-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { parseCsv, mapHeaders, importComputers } from './rmmImport';

initDb();
const db = getDb();
db.exec(`DELETE FROM employees; DELETE FROM employee_assets;`);
db.prepare(`INSERT INTO employees (id, legal_first_name, legal_last_name, work_email, upn, ad_username, office) VALUES (1,'Jane','Smith','jane.smith@1stfp.com','jane.smith@1stfp.com','jsmith','McAllen')`).run();
db.prepare(`INSERT INTO employees (id, legal_first_name, legal_last_name, work_email, office) VALUES (2,'Bob','Jones','bob.jones@1stfp.com','San Antonio')`).run();

test('parseCsv handles quotes, commas and CRLF', () => {
  const grid = parseCsv('a,b,c\r\n"x,1","y""q",z\r\n');
  assert.deepEqual(grid[0], ['a', 'b', 'c']);
  assert.deepEqual(grid[1], ['x,1', 'y"q', 'z']);
});

test('mapHeaders recognizes varied RMM column names', () => {
  const m = mapHeaders(['Computer Name', 'Serial Number', 'Model', 'Last Logged On User', 'User Email', 'Operating System']);
  assert.equal(m.device_name, 0);
  assert.equal(m.serial, 1);
  assert.equal(m.model, 2);
  assert.equal(m.user, 3);
  assert.equal(m.email, 4);
  assert.equal(m.os, 5);
});

test('preview matches by email / username / name without writing', () => {
  const csv = [
    'Device Name,Serial Number,Model,Last User,User Email,OS',
    'MCA-LT-01,SN123,ThinkPad,DOMAIN\\jsmith,,Windows 11',        // matches by username
    'SAT-LT-02,SN456,Latitude,,bob.jones@1stfp.com,Windows 11',   // matches by email
    'SHOP-PC,SN789,OptiPlex,Jane Smith,,Windows 10',              // matches by name
    'SPARE-01,SN000,NUC,,,Windows 11',                            // unmatched
  ].join('\n');
  const prev = importComputers(csv, 'tester', false);
  assert.equal(prev.ok, true);
  assert.equal(prev.committed, false);
  assert.equal(prev.total, 4);
  assert.equal(prev.matched, 3);
  assert.equal(prev.unmatched, 1);
  assert.equal((getDb().prepare(`SELECT COUNT(*) c FROM employee_assets`).get() as any).c, 0, 'preview writes nothing');
});

test('commit writes assets and is idempotent on re-import', () => {
  const csv = [
    'Device Name,Serial Number,Model,User Email',
    'MCA-LT-01,SN123,ThinkPad,jane.smith@1stfp.com',
    'SPARE-01,SN000,NUC,',
  ].join('\n');
  const first = importComputers(csv, 'tester', true);
  assert.equal(first.created, 2);
  assert.equal(first.updated, 0);
  const janeAsset = getDb().prepare(`SELECT employee_id, status, serial FROM employee_assets WHERE serial = 'SN123'`).get() as any;
  assert.equal(janeAsset.employee_id, 1);
  assert.equal(janeAsset.status, 'assigned');
  const spare = getDb().prepare(`SELECT employee_id, status FROM employee_assets WHERE serial = 'SN000'`).get() as any;
  assert.equal(spare.employee_id, null);
  assert.equal(spare.status, 'available');
  // re-import the same file: updates in place, no duplicates
  const second = importComputers(csv, 'tester', true);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 2);
  assert.equal((getDb().prepare(`SELECT COUNT(*) c FROM employee_assets WHERE serial IN ('SN123','SN000')`).get() as any).c, 2);
});

test('rejects a file with no device or serial column', () => {
  const out = importComputers('Foo,Bar\n1,2', 'tester', false);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /device-name or serial/);
});
