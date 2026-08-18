import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod } from './period';

const now = new Date('2026-08-18T15:00:00Z'); // a Tuesday

test('month is first-of-month to tomorrow', () => {
  const r = resolvePeriod('month', { now });
  assert.equal(r.start, '2026-08-01');
  assert.equal(r.end, '2026-08-19');
});

test('last month is the full prior calendar month', () => {
  const r = resolvePeriod('last_month', { now });
  assert.equal(r.start, '2026-07-01');
  assert.equal(r.end, '2026-08-01');
});

test('today is a single day', () => {
  const r = resolvePeriod('today', { now });
  assert.equal(r.start, '2026-08-18');
  assert.equal(r.end, '2026-08-19');
});

test('week starts Monday', () => {
  const r = resolvePeriod('week', { now });
  assert.equal(r.start, '2026-08-17'); // Monday
  assert.equal(r.end, '2026-08-19');
});

test('quarter and year anchor correctly', () => {
  assert.equal(resolvePeriod('quarter', { now }).start, '2026-07-01'); // Q3
  assert.equal(resolvePeriod('year', { now }).start, '2026-01-01');
});

test('all time is open-ended; custom validates dates', () => {
  const all = resolvePeriod('all', { now });
  assert.equal(all.start, null); assert.equal(all.end, null);
  const good = resolvePeriod('custom', { now, start: '2026-01-01', end: '2026-02-01' });
  assert.equal(good.start, '2026-01-01');
  const bad = resolvePeriod('custom', { now, start: 'nonsense' });
  assert.equal(bad.start, null);
});
