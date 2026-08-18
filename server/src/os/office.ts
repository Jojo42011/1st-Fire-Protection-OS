/**
 * Canonical office identity for the whole OS.
 *
 * The company's office name shows up in at least three different value-spaces across the systems
 * of record:
 *   1. ServiceTrade LLC names on jobs/quotes/appointments  — e.g. "1st FP Austin, LLC (AUS)"
 *   2. Friendly metro labels on deficiencies / on-call      — e.g. "Austin"
 *   3. Parenthetical branch codes inside the LLC name       — e.g. "(AUS)", "(MGMT)"
 *
 * Office scope is a security boundary (a Houston partner must never see Austin), so every scoped
 * query has to compare offices on ONE stable key, not on whichever string a given table happens to
 * store. `canonicalOffice()` collapses any of the three spaces to a single slug (the "office key").
 * It is a pure, deterministic function so it can be registered as a SQLite UDF (`os_office_key`) and
 * used directly inside WHERE clauses — scope is enforced in the query, never by filtering rows in JS.
 */

/** Parenthetical branch codes (the most reliable signal) → canonical office key. */
const CODE_TO_KEY: Record<string, string> = {
  aus: 'austin',
  hou: 'houston',
  mca: 'mcallen',
  waco: 'waco',
  ext: 'extinguishers',
  mgmt: 'management',
  lar: 'laredo',
  fps: 'services',
  cst: 'college-station',
  lub: 'lubbock',
  asds: 'asds',
  sat: 'services',
  sa: 'services',
};

/**
 * Cleaned name tokens → canonical office key. The keys here are the office name AFTER the company
 * prefix ("1st FP", "Northstar", ...) and the "LLC"/parenthetical suffix are stripped. This is what
 * lets a ServiceTrade "1st FP Austin, LLC" and a deficiency "Austin" resolve to the same office.
 */
const NAME_TO_KEY: Array<{ test: RegExp; key: string }> = [
  { test: /\bmcallen\b/, key: 'mcallen' },
  { test: /\bcollege\s*station\b/, key: 'college-station' },
  { test: /\baustin\s+sprinkler\s+design\b/, key: 'asds' },
  { test: /\bsprinkler\s+design\b/, key: 'asds' },
  { test: /\bsprinkler\s+companies\b/, key: 'management' },
  { test: /\bmanagement\b/, key: 'management' },
  { test: /\bextinguisher/, key: 'extinguishers' },
  { test: /\baustin\b/, key: 'austin' },
  { test: /\bhouston\b/, key: 'houston' },
  { test: /\bwaco\b/, key: 'waco' },
  { test: /\blaredo\b/, key: 'laredo' },
  { test: /\blubbock\b/, key: 'lubbock' },
  { test: /\bsan\s*antonio\b/, key: 'services' },
  { test: /^services$/, key: 'services' },
];

/** Curated display labels for the known canonical keys. Unknown keys fall back to a title-cased slug. */
const KEY_TO_LABEL: Record<string, string> = {
  austin: 'Austin',
  houston: 'Houston',
  mcallen: 'McAllen',
  waco: 'Waco',
  laredo: 'Laredo',
  lubbock: 'Lubbock',
  'college-station': 'College Station',
  extinguishers: 'Extinguishers',
  management: 'Management (HQ)',
  services: 'Services (San Antonio)',
  asds: 'Austin Sprinkler Design',
};

/** The sister security company is not a fire office; scope must never surface it. */
export function isNonOffice(raw: string | null | undefined): boolean {
  return /video digital|vds/i.test(String(raw || ''));
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Collapse any office string to a single canonical key. Returns '' for empty/non-office input so
 * callers can treat "no office" distinctly from a real branch.
 */
export function canonicalOffice(raw: string | null | undefined): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (isNonOffice(s)) return '';

  const lower = s.toLowerCase();

  // 1) Parenthetical branch code, e.g. "1st FP Austin, LLC (AUS)".
  const paren = lower.match(/\(([a-z0-9 ]{1,8})\)/);
  if (paren) {
    const code = paren[1].replace(/[^a-z0-9]/g, '');
    if (CODE_TO_KEY[code]) return CODE_TO_KEY[code];
  }

  // 1b) A bare branch code on its own, e.g. "AUS", "HOU".
  const bare = lower.replace(/[^a-z0-9]/g, '');
  if (CODE_TO_KEY[bare]) return CODE_TO_KEY[bare];

  // 2) Strip company prefixes, the LLC suffix, and any parenthetical, then match the metro token.
  const core = lower
    .replace(/\bnorthstar\b/g, ' ')
    .replace(/1st\s*fp\b/g, ' ')
    .replace(/1t\s*fp\b/g, ' ') // tolerate the "1t FP" typo that exists in the source data
    .replace(/1st\s*fire\s*protection\b/g, ' ')
    .replace(/fire\s*&?\s*safety\b/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bl\.?l\.?c\.?\b/g, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const { test, key } of NAME_TO_KEY) {
    if (test.test(core)) return key;
  }

  // 3) Stable fallback: the slug of the cleaned core (unknown branch still gets a consistent key).
  return slugify(core) || slugify(lower);
}

/** Human label for a canonical key. */
export function officeLabel(key: string): string {
  if (!key) return 'Unassigned';
  if (KEY_TO_LABEL[key]) return KEY_TO_LABEL[key];
  return key
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The curated set of known offices (key + label), for seeding and as a stable selector fallback. */
export function knownOffices(): Array<{ key: string; label: string }> {
  return Object.keys(KEY_TO_LABEL).map((key) => ({ key, label: KEY_TO_LABEL[key] }));
}
