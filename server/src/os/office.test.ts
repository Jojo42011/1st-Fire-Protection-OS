import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalOffice, officeLabel, isNonOffice } from './office';

test('the three office value-spaces collapse to one key', () => {
  // ServiceTrade LLC name, friendly metro label, and parenthetical code all → "austin".
  assert.equal(canonicalOffice('1st FP Austin, LLC (AUS)'), 'austin');
  assert.equal(canonicalOffice('Austin'), 'austin');
  assert.equal(canonicalOffice('Northstar Austin LLC'), 'austin');
  assert.equal(canonicalOffice('AUS'), 'austin'); // bare code is not parenthesized -> name path
});

test('every known branch resolves to its curated key', () => {
  assert.equal(canonicalOffice('1st FP Houston, LLC (HOU)'), 'houston');
  assert.equal(canonicalOffice('1st FP McAllen, LLC (MCA)'), 'mcallen');
  assert.equal(canonicalOffice('1st FP Waco, LLC (WACO)'), 'waco');
  assert.equal(canonicalOffice('1st FP Laredo, LLC. (LAR)'), 'laredo');
  assert.equal(canonicalOffice('1st FP Lubbock, LLC'), 'lubbock');
  assert.equal(canonicalOffice('1t FP College Station, LLC'), 'college-station'); // tolerate the source typo
  assert.equal(canonicalOffice('1st FP Extinguishers, LLC (EXT)'), 'extinguishers');
  assert.equal(canonicalOffice('1st FP Sprinkler Companies, LLC (MGMT)'), 'management');
  assert.equal(canonicalOffice('1st FP Services, LLC (FPS)'), 'services');
  assert.equal(canonicalOffice('Austin Sprinkler Design Services LLC (ASDS)'), 'asds');
});

test('the sister security company is never treated as an office', () => {
  assert.equal(isNonOffice('Video Digital Security'), true);
  assert.equal(canonicalOffice('VDS'), '');
  assert.equal(canonicalOffice('Video Digital Security LLC'), '');
});

test('empty / unknown input is handled without throwing', () => {
  assert.equal(canonicalOffice(''), '');
  assert.equal(canonicalOffice(null), '');
  assert.equal(canonicalOffice(undefined), '');
  // an unknown branch still gets a stable, non-empty key (its slug) so scoping keeps working
  const k = canonicalOffice('1st FP Somewhereville, LLC');
  assert.ok(k.length > 0);
  assert.equal(canonicalOffice('1st FP Somewhereville, LLC'), k); // deterministic
});

test('labels are curated for known keys, title-cased for unknown', () => {
  assert.equal(officeLabel('austin'), 'Austin');
  assert.equal(officeLabel('college-station'), 'College Station');
  assert.equal(officeLabel(''), 'Unassigned');
  assert.equal(officeLabel('somewhereville'), 'Somewhereville');
});
