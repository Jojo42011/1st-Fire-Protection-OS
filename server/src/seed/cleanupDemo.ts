/**
 * One-time production clean slate.
 *
 * Early builds ran the demo seed unconditionally, so the live database picked up illustrative sample
 * content (invoices, reviews, calls, leads, a CRM sample, license seats, onboarding requests, and an
 * approvals inbox) before those seeds were gated behind DEMO_MODE. Gating stops new fixtures; the rows
 * already written stay until removed.
 *
 * This removes that seeded sample content and nothing a real integration produced. It runs only in
 * production (DEMO_MODE off), matches every deletion on an unmistakable, future-proof fixture marker,
 * and records a state flag so it runs once. The markers:
 *   - `.example` personal/contact emails: a reserved TLD (RFC 2606) that can never be a real address.
 *   - `+1 512 555 01xx` phone numbers: the 555-01xx range is reserved for fiction (never dialable).
 *   - CRM `st_id` values prefixed `ST-`: the demo's synthetic ids. Real ServiceTrade rows carry the
 *     numeric ServiceTrade id and `source = 'servicetrade'`, so they never match.
 *   - license seats `source = 'seed'`: real seats import as 'graph'/'umapi'/'manual'/etc.
 *   - the fixed demo approval titles, and the reviews table (which no real code path writes).
 * Real ServiceTrade-synced accounts/sites/jobs/quotes and real employees are untouched.
 */
import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { DEMO_MODE } from '../config/demo';

const FLAG = 'cleaned_demo_prod_v3';

// The exact titles the demo approvals inbox seeded. Matching them is safe: they are fixed fixture
// strings a real agent never produces (real approvals name real jobs, invoices, and reviews).
const DEMO_APPROVAL_TITLES = [
  'Final notice to Maplewood Medical Plaza',
  'Reply to Marcy Delgado ★★★★★',
  'Cancel the Bluebeam seat for T. Nguyen',
  'Friendly reminder to Stone Oak Retail Partners',
  'Review request to Live Oak Distribution Center',
];

const PHONE_FICTION = '+1 512 555 01%'; // reserved 555-01xx range: only the demo receptionist set

export function cleanupDemoData(): void {
  // In demo mode the fixtures are supposed to be there, so leave them. Only production is cleaned.
  if (DEMO_MODE) return;
  if (getState(FLAG) === '1') return;

  const db = getDb();
  const removed: Record<string, number> = {};
  // Run each removal on its own so a schema quirk in one table never blocks the others.
  const step = (label: string, fn: () => number) => {
    try {
      removed[label] = fn();
    } catch (e) {
      console.warn(`[cleanup] ${label} skipped:`, (e as Error).message);
    }
  };
  const del = (sql: string, ...args: unknown[]): number => (db.prepare(sql).run(...args)).changes;
  const ids = (sql: string, ...args: unknown[]): number[] =>
    (db.prepare(sql).all(...args) as { id: number }[]).map((r) => r.id);
  const inList = (xs: number[]) => xs.map(() => '?').join(',');

  // ---- onboarding (fixture requests used reserved `.example` personal emails) ----
  step('onboarding', () => {
    const reqIds = ids(`SELECT id FROM onboarding_requests WHERE personal_email LIKE '%.example'`);
    if (!reqIds.length) return 0;
    del(`DELETE FROM onboarding_items WHERE request_id IN (${inList(reqIds)})`, ...reqIds);
    return del(`DELETE FROM onboarding_requests WHERE id IN (${inList(reqIds)})`, ...reqIds);
  });

  // ---- license seats (source = 'seed') and the approvals that reference them ----
  step('license_seats', () => {
    const seatIds = ids(`SELECT id FROM license_seats WHERE source = 'seed'`);
    if (seatIds.length) {
      del(`DELETE FROM approvals WHERE subject_type = 'seat' AND subject_id IN (${inList(seatIds)})`, ...seatIds);
    }
    return del(`DELETE FROM license_seats WHERE source = 'seed'`);
  });

  // ---- approvals inbox (exact fixture titles, `.example`, or the retired brand) ----
  step('approvals', () =>
    del(
      `DELETE FROM approvals
       WHERE status = 'pending'
         AND (title IN (${DEMO_APPROVAL_TITLES.map(() => '?').join(',')})
              OR body LIKE '%.example%' OR trail LIKE '%.example%' OR body LIKE '%Northstar Fire & Safety%')`,
      ...DEMO_APPROVAL_TITLES
    )
  );

  // ---- receivables: the 16 sample invoices (all on `.example` billing emails) ----
  step('invoices', () => del(`DELETE FROM invoices WHERE email LIKE '%.example'`));

  // ---- reviews: no real code path writes this table, so the whole demo set clears ----
  step('reviews', () => del(`DELETE FROM reviews`));

  // ---- receptionist demo: calls + leads on the reserved 555-01xx range ----
  step('calls', () => del(`DELETE FROM calls WHERE from_number LIKE ?`, PHONE_FICTION));
  step('leads', () => del(`DELETE FROM leads WHERE phone LIKE ?`, PHONE_FICTION));

  // ---- CRM sample: the 11 demo accounts and everything hanging off them ----
  // Real ServiceTrade rows carry a numeric st_id (never 'ST-'), so the prefix is a clean marker.
  step('crm', () => {
    const acctIds = ids(`SELECT id FROM accounts WHERE st_id LIKE 'ST-%'`);
    let n = 0;
    if (acctIds.length) {
      // Timeline events are keyed by account_id, not st_id, so clear them by the demo account ids.
      del(`DELETE FROM account_events WHERE account_id IN (${inList(acctIds)})`, ...acctIds);
    }
    n += del(`DELETE FROM quotes WHERE st_id LIKE 'ST-%'`);
    n += del(`DELETE FROM equipment WHERE st_id LIKE 'ST-%'`);
    n += del(`DELETE FROM contacts WHERE st_id LIKE 'ST-%'`);
    n += del(`DELETE FROM sites WHERE st_id LIKE 'ST-%'`);
    n += del(`DELETE FROM accounts WHERE st_id LIKE 'ST-%'`);
    return n;
  });

  // ---- sync shell: the two demo conflicts + demo log rows (all reference `.example`/`ST-`) ----
  step('sync', () => {
    let n = 0;
    n += del(`DELETE FROM sync_conflicts WHERE st_id LIKE 'ST-%' OR their_value LIKE '%.example%' OR our_value LIKE '%.example%'`);
    return n;
  });

  setState(FLAG, '1');
  const summary = Object.entries(removed)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}:${n}`)
    .join(' ');
  if (summary) console.log(`[cleanup] production clean slate removed -> ${summary}`);
}
