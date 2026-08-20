import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-software-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { addSoftwareApp, importSoftwareCsv, listSoftwareApps, employeeSoftware } from './softwareLicenses';

initDb();
const db = getDb();
db.exec(`DELETE FROM employees; DELETE FROM software_apps; DELETE FROM employee_software;`);
db.prepare(`INSERT INTO employees (id, legal_first_name, legal_last_name, work_email, employment_status) VALUES (1,'Devon','Booker','devon.booker@1stfp.com','active')`).run();
db.prepare(`INSERT INTO employees (id, legal_first_name, legal_last_name, entra_display_name, employment_status) VALUES (2,'Aurelio','Arias Espinoza','Aurelio Arias','active')`).run();

test('CSV import matches by email and by tolerant name, and records licenses', () => {
  const app = addSoftwareApp({ name: 'Bluebeam Revu', vendor: 'Bluebeam' })!;
  assert.ok(app.id > 0);
  const csv = ['Email,Full Name', 'devon.booker@1stfp.com,Devon Booker', ',Aurelio Arias', 'nobody@example.com,Ghost User'].join('\n');
  const preview = importSoftwareCsv(app.id, csv, false);
  assert.equal(preview.matched, 2, 'Devon by email, Aurelio by compound-surname name');
  assert.equal(preview.unmatched, 1);
  assert.equal(preview.committed, false);
  assert.equal(employeeSoftware(1).length, 0, 'preview writes nothing');

  const done = importSoftwareCsv(app.id, csv, true);
  assert.equal(done.matched, 2);
  assert.equal(employeeSoftware(1).some((s: any) => s.name === 'Bluebeam Revu'), true);
  assert.equal(listSoftwareApps().find((a) => a.id === app.id)!.licensed, 2);
});

test('re-importing without a user marks them removed', () => {
  const app = listSoftwareApps().find((a) => a.name === 'Bluebeam Revu')!;
  // Now only Devon is in the export; Aurelio should be dropped.
  const csv = ['Email,Full Name', 'devon.booker@1stfp.com,Devon Booker'].join('\n');
  const done = importSoftwareCsv(app.id, csv, true);
  assert.equal(done.matched, 1);
  assert.equal(done.removed, 1, 'Aurelio removed');
  assert.equal(employeeSoftware(2).length, 0);
  assert.equal(listSoftwareApps().find((a) => a.id === app.id)!.licensed, 1);
});

test('rejects a file with no email or name column', () => {
  const app = listSoftwareApps()[0];
  const out = importSoftwareCsv(app.id, 'seat,cost\n1,50', false);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /email or name/i);
});
