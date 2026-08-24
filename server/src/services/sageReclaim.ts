import { listSageUsers, SageUser } from './sageIntacct';
import { buildEmployeeIndex, matchAdToEmployee, EmpRow } from './adAudit';

/**
 * Sage Intacct license reclaim: match every Sage user to an active employee and flag the ones worth
 * money, terminated employees still holding a seat, and users with no employee record (service or
 * stale). The same pattern as the M365 license cleanup and the AD group drift. Read-only; keyless-safe.
 */

const norm = (s: string | null | undefined): string => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export type SageReclaimStatus = 'terminated' | 'no_employee' | 'ok';
export interface SageReclaimFinding {
  loginId: string | null;
  name: string | null;
  email: string | null;
  type: string | null;      // Business | Employee | Construction manager ...
  sageStatus: string | null;
  homeStatus: string | null; // the matched employee's employment status
  status: SageReclaimStatus;
}

export async function sageUserReclaim(): Promise<{
  ok: boolean; error?: string;
  findings: SageReclaimFinding[];
  counts: Record<string, number>;
  typeCounts: Record<string, number>;
}> {
  const res = await listSageUsers();
  if (!res.ok) return { ok: false, error: res.error, findings: [], counts: {}, typeCounts: {} };

  const idx = buildEmployeeIndex();
  // A name index as a fallback when the Sage user has no email (Sage login ids like "acall" won't match).
  const byName = new Map<string, EmpRow>();
  for (const e of idx.all) {
    const n = norm(`${e.legal_first_name || ''}${e.legal_last_name || ''}`);
    if (n) byName.set(n, e);
  }
  const matchEmp = (u: SageUser): EmpRow | undefined =>
    matchAdToEmployee({ email: u.email, upn: u.email }, idx) || (u.name ? byName.get(norm(u.name)) : undefined);

  const findings: SageReclaimFinding[] = [];
  for (const u of res.users) {
    const emp = matchEmp(u);
    let status: SageReclaimStatus = 'ok';
    if (!emp) status = 'no_employee';
    else if (norm(emp.employment_status) === 'terminated') status = 'terminated';
    findings.push({
      loginId: u.loginId, name: u.name || (emp ? `${emp.legal_first_name || ''} ${emp.legal_last_name || ''}`.trim() : null),
      email: u.email, type: u.type, sageStatus: u.status, homeStatus: emp ? emp.employment_status : null, status,
    });
  }

  const rank: Record<SageReclaimStatus, number> = { terminated: 0, no_employee: 1, ok: 2 };
  findings.sort((a, b) => rank[a.status] - rank[b.status] || (a.type || '').localeCompare(b.type || ''));
  const counts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.status] = (counts[f.status] || 0) + 1;
    if (f.type) typeCounts[f.type] = (typeCounts[f.type] || 0) + 1;
  }
  return { ok: true, findings, counts, typeCounts };
}
