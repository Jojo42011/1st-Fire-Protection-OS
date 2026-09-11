import { test } from 'node:test';
import assert from 'node:assert/strict';
import { last4, filterEntities, toPhoneCsv, PhoneRow } from './phoneList';

test('last4 strips formatting and takes the final four digits', () => {
  assert.equal(last4('(806) 555-1234'), '1234');
  assert.equal(last4('+1 806-555-0199'), '0199');
  assert.equal(last4('12'), '12');   // fewer than 4 -> all digits
  assert.equal(last4(''), '');
  assert.equal(last4(null), '');
});

const rows: PhoneRow[] = [
  { first: 'Ann', last: 'Reyes', last4: '1111', location: '1st FP Services, LLC', status: 'Active', hasPhone: true },
  { first: 'Bob', last: 'Vela', last4: '2222', location: 'MGMT', status: 'Active', hasPhone: true },
  { first: 'Cy', last: 'Gone', last4: '3333', location: '1st FP Services, LLC', status: 'Inactive', hasPhone: true },
  { first: 'Dee', last: 'Smith', last4: '4444', location: '1st FP McAllen, LLC', status: 'Active', hasPhone: true },
];

test('filterEntities matches location by punctuation-insensitive substring and active status', () => {
  const out = filterEntities(rows, ['1st fp services', 'mgmt', 'management']);
  assert.deepEqual(out.map((r) => r.first).sort(), ['Ann', 'Bob'], 'active Services + MGMT only');
  // McAllen is excluded; the inactive Services person is excluded by default.
  assert.ok(!out.some((r) => r.first === 'Dee'));
  assert.ok(!out.some((r) => r.first === 'Cy'));
  // Including inactive brings the terminated Services person back.
  assert.equal(filterEntities(rows, ['1st fp services'], false).length, 2);
});

test('toPhoneCsv emits exactly the three requested columns', () => {
  const csv = toPhoneCsv(filterEntities(rows, ['mgmt']));
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'First name,Last name,Last 4');
  assert.equal(lines[1], 'Bob,Vela,2222');
  assert.equal(lines.length, 2);
});
