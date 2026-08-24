import { getDb } from '../db/index';

/**
 * Active-employee roster + BambooHR data-gap report.
 *
 * The roster is name / position / office / work email for every current employee, with a missing
 * email backfilled from the AD mirror (matched by name) when the person has an account. The gap
 * report flags records HR should clean up: no office, no position, and "has an AD account but no work
 * email stamped" (the actionable one) vs "no mailbox at all" (expected for field staff).
 */

const nrm = (s: string | null | undefined): string => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** name -> best email from the AD mirror (enabled accounts), by given+surname and by display name. */
function adEmailByName(): Map<string, string> {
  const db = getDb();
  const m = new Map<string, string>();
  for (const a of db.prepare(`SELECT display_name, given_name, surname, upn, email FROM ad_users WHERE enabled = 1`).all() as any[]) {
    const mail = a.email || a.upn;
    if (!mail) continue;
    if (a.given_name && a.surname) m.set(nrm(a.given_name + a.surname), mail);
    if (a.display_name) m.set(nrm(a.display_name), mail);
  }
  return m;
}

const empName = (r: any): string =>
  (r.preferred_name && r.legal_last_name ? `${r.preferred_name} ${r.legal_last_name}` : (r.preferred_name || `${r.legal_first_name || ''} ${r.legal_last_name || ''}`.trim())) || '';

function activeRows(): any[] {
  return getDb().prepare(
    `SELECT legal_first_name, legal_last_name, preferred_name, upn, public_job_title, job_position, office, work_email
       FROM employees WHERE employment_status NOT IN ('terminated', 'prehire')
      ORDER BY office, legal_last_name, legal_first_name`
  ).all() as any[];
}

export interface RosterRow { name: string; position: string | null; office: string | null; email: string | null }

export function activeRoster(): { count: number; withEmail: number; roster: RosterRow[] } {
  const rows = activeRows();
  const ad = adEmailByName();
  const roster: RosterRow[] = rows.map((r) => {
    let email = r.work_email || r.upn || null;
    if (!email) email = ad.get(nrm(`${r.legal_first_name || ''}${r.legal_last_name || ''}`)) || (r.preferred_name ? ad.get(nrm(`${r.preferred_name}${r.legal_last_name || ''}`)) || null : null);
    return { name: empName(r), position: r.public_job_title || r.job_position || null, office: r.office || null, email };
  });
  return { count: roster.length, withEmail: roster.filter((x) => x.email).length, roster };
}

export type GapCode = 'no_office' | 'no_position' | 'account_no_email' | 'no_mailbox';
export interface GapFinding { name: string; office: string | null; position: string | null; email: string | null; gaps: GapCode[] }

export function employeeDataGaps(): { findings: GapFinding[]; counts: Record<string, number>; total: number } {
  const rows = activeRows();
  const ad = adEmailByName();
  const findings: GapFinding[] = [];
  for (const r of rows) {
    const name = empName(r);
    const office = r.office || null;
    const position = r.public_job_title || r.job_position || null;
    const stamped = r.work_email || r.upn || null;
    const adEmail = ad.get(nrm(`${r.legal_first_name || ''}${r.legal_last_name || ''}`)) || (r.preferred_name ? ad.get(nrm(`${r.preferred_name}${r.legal_last_name || ''}`)) : undefined) || null;
    const gaps: GapCode[] = [];
    if (!office) gaps.push('no_office');
    if (!position) gaps.push('no_position');
    if (!stamped && adEmail) gaps.push('account_no_email'); // has an account, Bamboo just isn't stamped
    else if (!stamped && !adEmail) gaps.push('no_mailbox');   // no account at all (field staff, usually fine)
    if (gaps.length) findings.push({ name, office, position, email: stamped || adEmail, gaps });
  }
  // Actionable first: office/position/account_no_email before the informational no_mailbox.
  const weight = (f: GapFinding) => (f.gaps.some((g) => g !== 'no_mailbox') ? 0 : 1);
  findings.sort((a, b) => weight(a) - weight(b) || (a.office || '').localeCompare(b.office || ''));
  const counts: Record<string, number> = {};
  for (const f of findings) for (const g of f.gaps) counts[g] = (counts[g] || 0) + 1;
  return { findings, counts, total: rows.length };
}

export function rosterCsv(): string {
  const { roster } = activeRoster();
  const esc = (v: string | null) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = ['Name,Position,Office,Email'];
  for (const r of roster) lines.push([r.name, r.position, r.office, r.email].map(esc).join(','));
  return lines.join('\n');
}
