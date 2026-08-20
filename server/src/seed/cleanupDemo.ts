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

const FLAG = 'cleaned_demo_prod_v1';

export function cleanupDemoData(): void {
  // In demo mode the fixtures are supposed to be there, so leave them. Only production is cleaned.
  if (DEMO_MODE) return;
  if (getState(FLAG) === '1') return;

  const db = getDb();
  let onboarding = 0;
  let approvals = 0;

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
    // Fixture approvals carry `.example` addresses in the body/trail or the retired brand signature.
    approvals = (
      db
        .prepare(
          `DELETE FROM approvals
           WHERE status = 'pending'
             AND (body LIKE '%.example%' OR trail LIKE '%.example%' OR body LIKE '%Northstar Fire & Safety%')`
        )
        .run()
    ).changes;
  } catch (e) {
    console.warn('[cleanup] approvals fixture removal skipped:', (e as Error).message);
  }

  setState(FLAG, '1');
  if (onboarding || approvals) {
    console.log(`[cleanup] removed ${onboarding} demo onboarding request(s) and ${approvals} demo approval(s) from production.`);
  }
}
