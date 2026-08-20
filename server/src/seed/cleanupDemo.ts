/**
 * One-time production cleanup.
 *
 * Early builds ran the demo seed unconditionally, so the live database picked up fixture onboarding
 * requests (Sofia Ramos, Marcus Bell, Grace Okoro) and a fixture approvals inbox before the seed was
 * gated behind DEMO_MODE. Gating stops new fixtures, but the rows already written stay until removed.
 *
 * This removes exactly those fixture rows and nothing a real person entered. It runs only in
 * production (DEMO_MODE off), matches on unmistakable fixture markers (personal emails on the
 * reserved `.example` domain, approval bodies carrying `.example` addresses or the retired
 * "Northstar Fire & Safety" brand), and records a state flag so it runs once.
 */
import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { DEMO_MODE } from '../config/demo';

const FLAG = 'cleaned_demo_prod_v2';

// The exact titles the demo approvals inbox seeded. Matching them is safe: they are fixed fixture
// strings a real agent never produces (real approvals name real jobs, invoices, and reviews).
const DEMO_APPROVAL_TITLES = [
  'Final notice to Maplewood Medical Plaza',
  'Reply to Marcy Delgado ★★★★★',
  'Cancel the Bluebeam seat for T. Nguyen',
  'Friendly reminder to Stone Oak Retail Partners',
  'Review request to Live Oak Distribution Center',
];

export function cleanupDemoData(): void {
  // In demo mode the fixtures are supposed to be there, so leave them. Only production is cleaned.
  if (DEMO_MODE) return;
  if (getState(FLAG) === '1') return;

  const db = getDb();
  let onboarding = 0;
  let approvals = 0;
  let seats = 0;

  try {
    // Fixture onboarding requests used reserved `.example` personal emails; a real hire never does.
    // onboarding_items has ON DELETE CASCADE, but we clear them explicitly in case foreign-key
    // enforcement is off on this connection.
    const reqIds = (
      db.prepare(`SELECT id FROM onboarding_requests WHERE personal_email LIKE '%.example'`).all() as { id: number }[]
    ).map((r) => r.id);
    if (reqIds.length) {
      const marks = reqIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM onboarding_items WHERE request_id IN (${marks})`).run(...reqIds);
      onboarding = (db.prepare(`DELETE FROM onboarding_requests WHERE id IN (${marks})`).run(...reqIds)).changes;
    }
  } catch (e) {
    console.warn('[cleanup] onboarding fixture removal skipped:', (e as Error).message);
  }

  try {
    // Demo license seats are tagged source = 'seed' (real ones are 'graph'/'umapi'/'manual'/etc.).
    // Remove the approvals that reference them first, then the seats (reclaims cascade). This clears
    // the "Cancel the ... seat for [former employee]" approvals about people who never worked here.
    const seatIds = (db.prepare(`SELECT id FROM license_seats WHERE source = 'seed'`).all() as { id: number }[]).map((r) => r.id);
    if (seatIds.length) {
      const marks = seatIds.map(() => '?').join(',');
      approvals += (db.prepare(`DELETE FROM approvals WHERE subject_type = 'seat' AND subject_id IN (${marks})`).run(...seatIds)).changes;
      seats = (db.prepare(`DELETE FROM license_seats WHERE source = 'seed'`).run()).changes;
    }

    // The seeded approvals inbox: match the exact fixture titles (catches the ones with no subject),
    // plus any leftover carrying `.example` addresses or the retired brand signature.
    const titleMarks = DEMO_APPROVAL_TITLES.map(() => '?').join(',');
    approvals += (
      db
        .prepare(
          `DELETE FROM approvals
           WHERE status = 'pending'
             AND (title IN (${titleMarks})
                  OR body LIKE '%.example%' OR trail LIKE '%.example%' OR body LIKE '%Northstar Fire & Safety%')`
        )
        .run(...DEMO_APPROVAL_TITLES)
    ).changes;
  } catch (e) {
    console.warn('[cleanup] approvals/seats fixture removal skipped:', (e as Error).message);
  }

  setState(FLAG, '1');
  if (onboarding || approvals || seats) {
    console.log(`[cleanup] removed ${onboarding} demo onboarding request(s), ${approvals} demo approval(s), ${seats} demo license seat(s) from production.`);
  }
}
