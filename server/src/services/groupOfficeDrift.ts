import { listGroupsWithMembers } from './msGraphGroups';
import { buildEmployeeIndex, matchAdToEmployee } from './adAudit';

/**
 * Group-vs-home-office drift.
 *
 * Location security groups (SG-SP-Austin, SG-SP-Houston, ...) should only contain people whose
 * BambooHR home office is that location. This report pulls the live group membership from Entra,
 * matches each member to their employee record, and flags anyone sitting in a location group that
 * does not match their home office (e.g. an Austin tech in SG-SP-Houston). Function groups (HR,
 * Accounting, Management, ...) are not location-based, so they are ignored automatically: a group is
 * only treated as a location group when its name suffix matches a real employee office.
 */

const norm = (s: string | null | undefined): string => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export type DriftStatus = 'office_mismatch' | 'no_home_office' | 'no_employee' | 'disabled_in_group';

export interface OfficeDriftFinding {
  group: string;
  groupOffice: string;   // the office this location group represents
  person: string | null;
  upn: string | null;
  homeOffice: string | null;
  enabled: boolean | null;
  status: DriftStatus;
}

/** A BambooHR office string and a group suffix refer to the same place when one normalized form
 *  contains the other, so "Austin, TX" or "1st FP - Austin" both match the "Austin" group. */
function officeMatches(officeNorm: string, suffixNorm: string): boolean {
  if (!officeNorm || !suffixNorm) return false;
  if (officeNorm === suffixNorm) return true;
  // Contains-matching only for suffixes long enough to be a real place name, so short function-group
  // suffixes (IT, HR) do not accidentally substring-match an office string.
  if (suffixNorm.length >= 4 && officeNorm.includes(suffixNorm)) return true;
  if (officeNorm.length >= 4 && suffixNorm.includes(officeNorm)) return true;
  return false;
}

export interface OfficeDriftDiagnostics {
  groups: number;
  locationGroups: number;
  employeesTotal: number;
  employeesWithOffice: number;
  distinctOffices: string[];      // the real BambooHR office values, so naming mismatches are visible
  nonLocationGroups: string[];    // SG-SP-* groups not treated as locations (function groups etc.)
  membersChecked: number;
  membersMatchedToEmployee: number;
}

export async function computeOfficeDrift(prefix = 'SG-SP-'): Promise<{
  ok: boolean; error?: string;
  findings: OfficeDriftFinding[];
  locationGroups: { group: string; office: string; members: number }[];
  counts: Record<string, number>;
  diagnostics: OfficeDriftDiagnostics;
}> {
  const empty: OfficeDriftDiagnostics = { groups: 0, locationGroups: 0, employeesTotal: 0, employeesWithOffice: 0, distinctOffices: [], nonLocationGroups: [], membersChecked: 0, membersMatchedToEmployee: 0 };
  const res = await listGroupsWithMembers(prefix);
  if (!res.ok) return { ok: false, error: res.error, findings: [], locationGroups: [], counts: {}, diagnostics: empty };

  const idx = buildEmployeeIndex();
  const officesNorm: { norm: string; label: string }[] = [];
  const distinct = new Map<string, string>();
  for (const e of idx.all) if (e.office) { const n = norm(e.office); if (!distinct.has(n)) distinct.set(n, e.office); }
  for (const [n, label] of distinct) officesNorm.push({ norm: n, label });

  const findings: OfficeDriftFinding[] = [];
  const locationGroups: { group: string; office: string; members: number }[] = [];
  const nonLocation: string[] = [];
  let membersChecked = 0, membersMatched = 0;

  for (const g of res.groups) {
    const suffix = g.name.replace(new RegExp(`^${prefix}`, 'i'), '');
    const suffixNorm = norm(suffix);
    // A group is a location group when its suffix matches at least one real employee office.
    const isLocation = officesNorm.some((o) => officeMatches(o.norm, suffixNorm));
    if (!isLocation) { nonLocation.push(g.name); continue; }
    locationGroups.push({ group: g.name, office: suffix, members: g.members.length });

    for (const m of g.members) {
      membersChecked++;
      const emp = matchAdToEmployee({ upn: m.upn, email: m.upn }, idx);
      if (emp) membersMatched++;
      if (m.enabled === false) {
        findings.push({ group: g.name, groupOffice: suffix, person: m.name, upn: m.upn, homeOffice: emp ? emp.office : null, enabled: false, status: 'disabled_in_group' });
        continue;
      }
      if (!emp) {
        findings.push({ group: g.name, groupOffice: suffix, person: m.name, upn: m.upn, homeOffice: null, enabled: m.enabled, status: 'no_employee' });
        continue;
      }
      if (!emp.office) {
        findings.push({ group: g.name, groupOffice: suffix, person: m.name, upn: m.upn, homeOffice: null, enabled: m.enabled, status: 'no_home_office' });
        continue;
      }
      if (!officeMatches(norm(emp.office), suffixNorm)) {
        findings.push({ group: g.name, groupOffice: suffix, person: m.name, upn: m.upn, homeOffice: emp.office, enabled: m.enabled, status: 'office_mismatch' });
      }
    }
  }

  const rank: Record<DriftStatus, number> = { office_mismatch: 0, disabled_in_group: 1, no_home_office: 2, no_employee: 3 };
  findings.sort((a, b) => rank[a.status] - rank[b.status] || a.group.localeCompare(b.group));
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.status] = (counts[f.status] || 0) + 1;

  const diagnostics: OfficeDriftDiagnostics = {
    groups: res.groups.length,
    locationGroups: locationGroups.length,
    employeesTotal: idx.all.length,
    employeesWithOffice: idx.all.filter((e) => !!e.office).length,
    distinctOffices: [...distinct.values()].sort(),
    nonLocationGroups: nonLocation.sort(),
    membersChecked,
    membersMatchedToEmployee: membersMatched,
  };
  return { ok: true, findings, locationGroups, counts, diagnostics };
}
