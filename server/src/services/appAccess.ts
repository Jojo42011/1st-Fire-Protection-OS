import { getDb } from '../db/index';

/**
 * Does this person actually hold an account in an app (Sage Intacct, ServiceTrade)? Read from the
 * app's latest user list (uploaded export or live API pull) as recorded in employee_software.
 *
 * Offboarding uses this to skip "remove from Sage / ServiceTrade" tasks for people who never had the
 * app, so Accounting and ServiceTrade only get tasks that need doing. It errs toward "unknown" (keep
 * the task) whenever the list cannot be trusted for this person:
 *   - the app's list has never been loaded,
 *   - the person cannot be tied to an employee record,
 *   - they started after the list was taken,
 *   - an unmatched row in the list could be them (same last name),
 *   - or their onboarding asked for the app.
 */

export type AccessState = 'active' | 'removed' | 'none' | 'unknown';
export interface AppAccess { state: AccessState; asOf: string | null; ref: string | null }

const lc = (s: unknown) => String(s ?? '').trim().toLowerCase();
const day = (s: string | null | undefined) => String(s || '').slice(0, 10);

/** The onboarding field that requests each app, so a hire granted access after the list was taken counts. */
const ONBOARDING_FIELD: Record<string, 'sage' | 'servicetrade'> = { 'sage intacct': 'sage', servicetrade: 'servicetrade' };

/** The employee an offboarding (or any person record) refers to: id, then work email / UPN, then a unique name. */
export function employeeIdFor(p: { employee_id?: number | null; upn?: string | null; name?: string | null }): number | null {
  const db = getDb();
  if (p.employee_id) return Number(p.employee_id);
  if (p.upn) {
    const r = db.prepare(`SELECT id FROM employees WHERE lower(work_email) = ? OR lower(upn) = ? ORDER BY id DESC LIMIT 1`).get(lc(p.upn), lc(p.upn)) as { id: number } | undefined;
    if (r) return r.id;
  }
  if (p.name) {
    const rows = db.prepare(
      `SELECT id FROM employees WHERE lower(trim(coalesce(preferred_name, legal_first_name) || ' ' || legal_last_name)) = ?
          OR lower(trim(legal_first_name || ' ' || legal_last_name)) = ?`
    ).all(lc(p.name), lc(p.name)) as { id: number }[];
    if (rows.length === 1) return rows[0].id;
  }
  return null;
}

export function appAccessFor(p: { employee_id?: number | null; upn?: string | null; name?: string | null }, appName: string): AppAccess {
  const db = getDb();
  const unknown: AppAccess = { state: 'unknown', asOf: null, ref: null };
  const app = db.prepare(`SELECT id, last_import_at, last_unmatched_json FROM software_apps WHERE lower(name) = ?`).get(lc(appName)) as
    { id: number; last_import_at: string | null; last_unmatched_json: string | null } | undefined;
  if (!app || !app.last_import_at) return unknown;
  const asOf = app.last_import_at;
  const empId = employeeIdFor(p);
  if (!empId) return unknown;

  const row = db.prepare(`SELECT status, removed_at, external_ref FROM employee_software WHERE employee_id = ? AND app_id = ?`).get(empId, app.id) as
    { status: string; removed_at: string | null; external_ref: string | null } | undefined;
  if (row && row.status === 'active') return { state: 'active', asOf, ref: row.external_ref };

  const field = ONBOARDING_FIELD[lc(appName)];
  if (field) {
    const asked = db.prepare(`SELECT 1 FROM onboarding_requests WHERE employee_id = ? AND ${field} IS NOT NULL AND trim(${field}) != '' AND status != 'cancelled' LIMIT 1`).get(empId);
    if (asked) return { state: 'unknown', asOf, ref: null };
  }
  if (row && row.status === 'removed') return { state: 'removed', asOf: row.removed_at || asOf, ref: row.external_ref };

  const emp = db.prepare(`SELECT legal_last_name, actual_start_date, anticipated_start_date FROM employees WHERE id = ?`).get(empId) as any;
  if (!emp) return unknown;
  const started = day(emp.actual_start_date || emp.anticipated_start_date);
  if (started && started > day(asOf)) return unknown;
  const last = lc(emp.legal_last_name);
  let unmatched: string[] = [];
  try { unmatched = JSON.parse(app.last_unmatched_json || '[]'); } catch { /* treat as none */ }
  if (last && unmatched.some((u) => lc(u).split(/[\s,.@_]+/).includes(last))) return unknown;
  return { state: 'none', asOf, ref: null };
}

/** Offboarding steps that only apply when the person holds the app. */
export const APP_GATED_ACTIONS: Record<string, string> = {
  hr_sage_remove: 'Sage Intacct',
  acct_ap_approver: 'Sage Intacct', // AP approval and bill-pay authorization live in Sage
  hr_servicetrade_remove: 'ServiceTrade',
};
