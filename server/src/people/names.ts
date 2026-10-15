/**
 * Person names, always "First Last". BambooHR writes supervisors as "Last, First" and some directory
 * accounts carry the same order; everything the OS stores or shows goes through firstLast().
 */
import type Database from 'better-sqlite3';

const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;

/** "Ruiz, Dana" -> "Dana Ruiz"; "Kernes, John, Jr" -> "John Kernes Jr"; "John Kernes, Jr" stays as is. */
export function firstLast(name: string | null | undefined): string {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!s.includes(',')) return s;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  const rest = parts.slice(1);
  if (rest.every((p) => SUFFIX.test(p))) return s; // "First Last, Jr" is already in order
  const given = rest.filter((p) => !SUFFIX.test(p)).join(' ');
  const suffix = rest.filter((p) => SUFFIX.test(p)).join(' ');
  return [given, parts[0], suffix].filter(Boolean).join(' ');
}
/** firstLast, but null stays null (for nullable columns). */
export const firstLastOrNull = (name: string | null | undefined): string | null => (name == null ? null : firstLast(name) || null);

/** Columns that hold a person's name from BambooHR or the directory. */
const NAME_COLUMNS: [string, string][] = [
  ['employees', 'manager'], ['employees', 'entra_display_name'], ['people_workflows', 'manager'],
  ['onboarding_requests', 'manager_name'], ['intake_links', 'recipient_name'], ['teams_voice_users', 'display_name'],
  ['license_seats', 'assignee_name'], ['ad_users', 'display_name'], ['app_users', 'display_name'], ['hr_employees', 'full_name'],
];

/** Rewrite any stored "Last, First" name as "First Last". Idempotent; safe to run at every boot. */
export function flipStoredNames(db: Database.Database): number {
  let n = 0;
  for (const [table, col] of NAME_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) continue;
    const rows = db.prepare(`SELECT rowid AS rid, ${col} AS v FROM ${table} WHERE ${col} LIKE '%,%'`).all() as { rid: number; v: string }[];
    const up = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`);
    for (const r of rows) {
      const v = firstLast(r.v);
      if (v !== r.v) { up.run(v, r.rid); n++; }
    }
  }
  return n;
}
