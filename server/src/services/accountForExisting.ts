import { getDb } from '../db/index';
import { adAccountsByEmployee } from './adDirectoryAudit';
import { createRequest, OnboardingItem } from './onboardingAgent';

/**
 * An AD account and company email for someone already working here: a BambooHR employee (often
 * months in) who never got one. IT picks them from BambooHR on the onboarding page; this creates an
 * "account only" onboarding request bound to their record, so the usual "Create on the DC" job and
 * the PowerShell script build the account from BambooHR (name, title, office, phone) exactly as for
 * a new hire, and the request carries only IT's tasks.
 */

export interface ExistingCandidate {
  id: number;
  name: string;
  office: string | null;
  department: string | null;
  title: string | null;
  started: string | null;
  workEmail: string | null;
  ad: { sam: string | null; upn: string | null; enabled: boolean } | null;
  openRequestId: number | null; // an open account-only request already exists for them
}

export function existingEmployeeCandidates(): { adSynced: boolean; people: ExistingCandidate[] } {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, legal_first_name, legal_last_name, preferred_name, office, department, job_position, public_job_title,
            actual_start_date, anticipated_start_date, work_email, employment_status
       FROM employees WHERE COALESCE(employment_status, '') NOT IN ('terminated', 'prehire')`
  ).all() as any[];
  const adSynced = (db.prepare(`SELECT COUNT(*) AS c FROM ad_users`).get() as { c: number }).c > 0;
  const ad = adSynced ? adAccountsByEmployee() : new Map();
  const open = new Map<number, number>();
  for (const r of db.prepare(`SELECT id, employee_id FROM onboarding_requests WHERE request_type = 'account_only' AND status = 'open' AND employee_id IS NOT NULL`).all() as { id: number; employee_id: number }[]) open.set(r.employee_id, r.id);
  const people: ExistingCandidate[] = rows.map((r) => ({
    id: r.id,
    name: [r.preferred_name || r.legal_first_name, r.legal_last_name].filter(Boolean).join(' ').trim() || `Employee ${r.id}`,
    office: r.office || null,
    department: r.department || null,
    title: r.public_job_title || r.job_position || null,
    started: r.actual_start_date || r.anticipated_start_date || null,
    workEmail: r.work_email || null,
    ad: ad.get(r.id) || null,
    openRequestId: open.get(r.id) || null,
  }));
  // Who needs one first: no enabled AD account, then by name.
  const needs = (p: ExistingCandidate) => (p.ad && p.ad.enabled ? 1 : 0);
  people.sort((a, b) => needs(a) - needs(b) || a.name.localeCompare(b.name));
  return { adSynced, people };
}

export interface AccountRequestInput {
  employee_id: number;
  account_type?: 'AD + Email' | 'Email Only';
  sharepoint?: string[];
  printers?: string[];
  teams_number?: boolean;
  note?: string;
}

/** Today's date in Central time (YYYY-MM-DD): the IT task is due now, not on a future start date. */
function todayCentral(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function createAccountRequest(input: AccountRequestInput): { request: any; items: OnboardingItem[]; warning: string | null } {
  const db = getDb();
  const id = Number(input && input.employee_id);
  const e = id ? (db.prepare(`SELECT * FROM employees WHERE id = ?`).get(id) as any) : null;
  if (!e) throw new Error('Pick an employee from BambooHR.');
  if (['terminated', 'prehire'].includes(String(e.employment_status || ''))) throw new Error('That employee is not active in BambooHR.');
  const open = db.prepare(`SELECT id FROM onboarding_requests WHERE request_type = 'account_only' AND status = 'open' AND employee_id = ?`).get(id) as { id: number } | undefined;
  if (open) throw new Error(`An account request for this person is already open (request #${open.id}).`);
  const acct = adAccountsByEmployee().get(id);
  const warning = acct && acct.enabled ? `AD already has an enabled account for them (${acct.sam || acct.upn}). The script stops rather than overwrite it.` : null;
  const name = [e.preferred_name || e.legal_first_name, e.legal_last_name].filter(Boolean).join(' ').trim() || `Employee ${id}`;
  const out = createRequest({
    name,
    employee_id: id,
    start_date: todayCentral(),
    job_position: e.public_job_title || e.job_position || undefined,
    manager_name: e.manager || undefined,
    company_email: true,
    teams_number: !!input.teams_number,
    sharepoint: Array.isArray(input.sharepoint) ? input.sharepoint.map(String) : [],
    printers: Array.isArray(input.printers) ? input.printers.map(String) : [],
    request_type: 'account_only',
    account_type: input.account_type === 'AD + Email' ? 'AD + Email' : 'Email Only',
    note: String(input.note || '').slice(0, 500),
  });
  return { ...out, warning };
}
