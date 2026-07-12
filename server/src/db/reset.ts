import { getDb } from './index';
import { seed } from '../seed/index';

/**
 * Every table the demo owns, in FK-safe delete order (children before parents).
 * system_state is handled separately — we only clear the `seeded` flag so the
 * next seed() runs, and leave any other operational keys intact.
 */
const DATA_TABLES = [
  // brain / memory (edges reference nodes)
  'edges',
  'nodes',
  'facts',
  'episodes',
  'rules',
  'syntheses',
  // invoice collector (children reference invoices / workflow)
  'invoice_workflow_log',
  'invoice_workflow',
  'invoice_reminders',
  'invoices',
  // review collector (review_requests reference jobs)
  'review_requests',
  'reviews',
  'jobs',
  // receptionist
  'leads',
  'calls',
  // brain chat
  'conversations',
] as const;

export interface ResetResult {
  cleared: number; // rows deleted across all data tables
  reseeded: boolean;
}

/**
 * Wipe all demo data and re-seed the sample dataset from scratch.
 *
 * Idempotent-safe to call at any time: clears every data table, resets the
 * AUTOINCREMENT counters so re-seeded rows get stable ids, drops the `seeded`
 * guard, then runs seed() again. The schema itself is untouched (initDb owns it),
 * so this never drops tables or loses migrations.
 */
export function resetDb(): ResetResult {
  const db = getDb();

  const wipe = db.transaction(() => {
    let cleared = 0;
    // FKs are ON; delete children-first order above keeps every delete legal.
    for (const table of DATA_TABLES) {
      cleared += db.prepare(`DELETE FROM ${table}`).run().changes;
      // reset AUTOINCREMENT so re-seeded ids start at 1 again (no-op if unused)
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
    }
    // drop the seed guard so seed() will run; keep other system_state keys
    db.prepare(`DELETE FROM system_state WHERE key = 'seeded'`).run();
    return cleared;
  });

  const cleared = wipe();
  seed();
  return { cleared, reseeded: true };
}
