import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeDeficiencyOffice, cityToOffice } from '../services/deficiencySync';

test('a deficiency is attributed by its job office (authoritative) over the city', () => {
  // Job says Houston; the location city says Austin. The JOB wins (assignedOffice is authoritative).
  const r = attributeDeficiencyOffice({ jobOfficeName: '1st FP Houston, LLC (HOU)', city: 'Austin' });
  assert.deepEqual(r, { key: 'houston', via: 'job' });
});

test('job office is canonicalized across value-spaces', () => {
  assert.equal(attributeDeficiencyOffice({ jobOfficeName: '1st FP McAllen LLC' }).key, 'mcallen');
  assert.equal(attributeDeficiencyOffice({ jobOfficeName: '1st FP Services LLC' }).key, 'services');
});

test('falls back to the location metro only when the job office is unknown', () => {
  const r = attributeDeficiencyOffice({ jobOfficeName: null, city: 'Katy' });
  assert.deepEqual(r, { key: 'houston', via: 'city' }); // Katy is Houston metro
  const r2 = attributeDeficiencyOffice({ jobOfficeName: '', city: 'San Antonio' });
  assert.deepEqual(r2, { key: 'services', via: 'city' });
});

test('the city fallback now yields REAL office keys, never demo labels', () => {
  // These metros used to map to demo labels (Riverton/Fairview/Millbrook/Lakeside); now real keys.
  assert.equal(cityToOffice('boerne'), 'services');   // was "Riverton"
  assert.equal(cityToOffice('mission'), 'mcallen');   // was "Fairview"
  assert.equal(cityToOffice('temple'), 'waco');       // was "Millbrook"
  assert.equal(cityToOffice('eagle pass'), 'laredo'); // was "Lakeside"
  // no demo labels are ever produced
  for (const c of ['boerne', 'mission', 'temple', 'eagle pass', 'austin', 'houston']) {
    const k = cityToOffice(c);
    assert.ok(!['riverton', 'fairview', 'millbrook', 'lakeside'].includes(k || ''));
  }
});

test('returns null (not a guess) when neither job nor city resolves', () => {
  assert.deepEqual(attributeDeficiencyOffice({ jobOfficeName: null, city: 'Nowhereville' }), { key: null, via: 'none' });
  assert.deepEqual(attributeDeficiencyOffice({}), { key: null, via: 'none' });
});

test('the sister security company is never attributed as an office', () => {
  assert.deepEqual(attributeDeficiencyOffice({ jobOfficeName: 'Video Digital Security LLC', city: 'Houston' }), { key: 'houston', via: 'city' });
});
