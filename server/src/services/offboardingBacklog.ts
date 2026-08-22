import { getDb } from '../db/index';
import { buildEmployeeIndex, matchAdToEmployee } from './adAudit';
import { createOffboarding, hasOffboarding } from './offboardingAgent';

/**
 * Backlog sweep: turn the pile of already-terminated AD accounts into an approvable list.
 *
 * A candidate is either an account matched to a terminated employee, or (heuristic) a disabled
 * account 90+ days old with no matching active employee. Accounts that already have an offboarding
 * request are excluded. Selecting candidates creates offboarding requests (source = backlog) so they
 * run through the same SOP as a fresh termination.
 */

const OLD_DAYS = 90;

export interface BacklogCandidate {
  object_guid: string;
  sam: string | null;
  upn: string | null;
  name: string | null;
  ou: string | null;
  enabled: boolean;
  groups: number;
  ageDays: number | null;
  employee_id: number | null;
  reason: string;
  severity: 'critical' | 'high' | 'medium';
}

function ageDaysFrom(...dates: (string | null)[]): number | null {
  const now = Date.now();
  let newest: number | null = null;
  for (const d of dates) {
    if (!d) continue;
    const t = new Date(d).getTime();
    if (!isNaN(t)) newest = newest === null ? t : Math.max(newest, t);
  }
  if (newest === null) return null;
  return Math.floor((now - newest) / 86400000);
}

export function backlogCandidates(): BacklogCandidate[] {
  const db = getDb();
  const adUsers = db.prepare(`SELECT * FROM ad_users`).all() as any[];
  const groupCounts = db.prepare(`SELECT object_guid, COUNT(*) AS c FROM ad_user_groups GROUP BY object_guid`).all() as { object_guid: string; c: number }[];
  const groupsByGuid = new Map(groupCounts.map((g) => [g.object_guid, g.c]));
  const idx = buildEmployeeIndex();

  const out: BacklogCandidate[] = [];
  for (const a of adUsers) {
    const e = matchAdToEmployee(a, idx);
    const terminated = e && (e.employment_status || '').trim().toLowerCase() === 'terminated';
    const age = ageDaysFrom(a.last_logon, a.when_created);
    let reason = '', severity: BacklogCandidate['severity'] | '' = '';

    if (terminated) {
      if (a.enabled) { reason = 'Matched to a terminated employee, still enabled'; severity = 'critical'; }
      else { reason = 'Matched to a terminated employee'; severity = 'high'; }
    } else if (!e && !a.enabled && age !== null && age >= OLD_DAYS) {
      reason = `Disabled ${age}+ days, no employee match`; severity = 'medium';
    } else {
      continue;
    }
    if (hasOffboarding({ employee_id: e ? e.id : undefined, upn: a.upn, object_guid: a.object_guid })) continue;

    out.push({
      object_guid: a.object_guid,
      sam: a.sam || null,
      upn: a.upn || null,
      name: a.display_name || null,
      ou: a.ou || null,
      enabled: !!a.enabled,
      groups: groupsByGuid.get(a.object_guid) || 0,
      ageDays: age,
      employee_id: e ? e.id : null,
      reason,
      severity: severity as BacklogCandidate['severity'],
    });
  }
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2 };
  out.sort((x, y) => rank[x.severity] - rank[y.severity] || (y.ageDays || 0) - (x.ageDays || 0));
  return out;
}

/** Create offboarding requests for the selected AD accounts (by object_guid). */
export function createFromBacklog(guids: string[], by = 'operator'): { created: number; skipped: number; ids: number[] } {
  const db = getDb();
  const idx = buildEmployeeIndex();
  let created = 0, skipped = 0;
  const ids: number[] = [];
  for (const guid of guids) {
    const a = db.prepare(`SELECT * FROM ad_users WHERE object_guid = ?`).get(guid) as any;
    if (!a) { skipped++; continue; }
    const e = matchAdToEmployee(a, idx);
    if (hasOffboarding({ employee_id: e ? e.id : undefined, upn: a.upn, object_guid: a.object_guid })) { skipped++; continue; }
    const out = createOffboarding({
      employee_id: e ? e.id : undefined,
      object_guid: a.object_guid,
      name: a.display_name || a.sam || a.upn || 'Unknown',
      upn: a.upn || undefined,
      sam: a.sam || undefined,
      manager_email: e ? e.manager || undefined : undefined,
      office: (e && e.office) || a.office || undefined,
      source: 'backlog',
      created_by: by,
    });
    ids.push(out.request.id);
    created++;
  }
  return { created, skipped, ids };
}
