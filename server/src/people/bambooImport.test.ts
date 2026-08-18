import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBambooRow } from './service';
import { BambooImportRow } from '../services/bamboo';

const row = (over: Partial<BambooImportRow>): BambooImportRow => ({
  id: '42',
  employeeNumber: '1001',
  firstName: 'Jane',
  lastName: 'Doe',
  preferredName: 'Janie',
  displayName: 'Jane Doe',
  jobTitle: 'Service Technician',
  department: 'Service',
  location: 'San Antonio',
  workEmail: 'jane@1stfp.com',
  homeEmail: 'jane@gmail.com',
  mobilePhone: '210-555-0100',
  hireDate: '2021-03-01',
  status: 'Active',
  supervisor: 'Daniel Ramos',
  ...over,
});

test('maps a full Bamboo row onto employees columns', () => {
  const m = mapBambooRow(row({}));
  assert.ok(m);
  assert.equal(m!.bamboo_id, '42');
  assert.equal(m!.employee_number, '1001');
  assert.equal(m!.legal_first_name, 'Jane');
  assert.equal(m!.legal_last_name, 'Doe');
  assert.equal(m!.preferred_name, 'Janie');
  assert.equal(m!.work_email, 'jane@1stfp.com');
  assert.equal(m!.personal_email, 'jane@gmail.com'); // homeEmail -> personal_email
  assert.equal(m!.personal_phone, '210-555-0100');
  assert.equal(m!.office, 'San Antonio'); // location -> office
  assert.equal(m!.department, 'Service');
  assert.equal(m!.public_job_title, 'Service Technician');
  assert.equal(m!.job_position, 'Service Technician'); // seeds the role-template match
  assert.equal(m!.manager, 'Daniel Ramos'); // supervisor -> manager
  assert.equal(m!.actual_start_date, '2021-03-01');
  assert.equal(m!.bamboo_status, 'active');
});

test('Inactive status maps to terminated (Bamboo never says "Terminated")', () => {
  assert.equal(mapBambooRow(row({ status: 'Inactive' }))!.bamboo_status, 'terminated');
  assert.equal(mapBambooRow(row({ status: 'inactive' }))!.bamboo_status, 'terminated');
  assert.equal(mapBambooRow(row({ status: 'Active' }))!.bamboo_status, 'active');
  assert.equal(mapBambooRow(row({ status: null }))!.bamboo_status, 'active');
});

test('the 0000-00-00 placeholder hire date is nulled out', () => {
  assert.equal(mapBambooRow(row({ hireDate: '0000-00-00' }))!.actual_start_date, null);
  assert.equal(mapBambooRow(row({ hireDate: null }))!.actual_start_date, null);
});

test('a row with no Bamboo id is skipped (can not upsert idempotently)', () => {
  assert.equal(mapBambooRow(row({ id: null })), null);
});
