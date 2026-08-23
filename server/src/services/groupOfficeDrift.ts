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

export async function computeOfficeDrift(prefix = 'SG-SP-'): Promise<{
  ok: boolean; error?: string;
  findings: OfficeDriftFinding[];
  locationGroups: { group: string; office: string; members: number }[];
  counts: Record<string, number>;
}> {
  const res = await listGroupsWithMembers(prefix);
  if (!res.ok) return { ok: false, error: res.error, findings: [], locationGroups: [], counts: {} };

  const idx = buildEmployeeIndex();
  // Map of normalized office -> a display label, from the real employee roster.
  const officeByNorm = new Map<string, string>();
  for (const e of idx.all) if (e.office) officeByNorm.set(norm(e.office), e.office);

  const findings: OfficeDriftFinding[] = [];
  const locationGroups: { group: string; office: string; members: number }[] = [];

  for (const g of res.groups) {
    const suffix = g.name.replace(new RegExp(`^${prefix}`, 'i'), '');
    const groupOfficeLabel = officeByNorm.get(norm(suffix));
    if (!groupOfficeLabel) continue; // not a location group (function group, or an office with no staff)
    locationGroups.push({ group: g.name, office: groupOfficeLabel, members: g.members.length });

    for (const m of g.members) {
      const emp = matchAdToEmployee({ upn: m.upn, email: m.upn }, idx);
      if (m.enabled === false) {
        findings.push({ group: g.name, groupOffice: groupOfficeLabel, person: m.name, upn: m.upn, homeOffice: emp ? emp.office : null, enabled: false, status: 'disabled_in_group' });
        continue;
      }
      if (!emp) {
        findings.push({ group: g.name, groupOffice: groupOfficeLabel, person: m.name, upn: m.upn, homeOffice: null, enabled: m.enabled, status: 'no_employee' });
        continue;
      }
      if (!emp.office) {
        findings.push({ group: g.name, groupOffice: groupOfficeLabel, person: m.name, upn: m.upn, homeOffice: null, enabled: m.enabled, status: 'no_home_office' });
        continue;
      }
      if (norm(emp.office) !== norm(groupOfficeLabel)) {
        findings.push({ group: g.name, groupOffice: groupOfficeLabel, person: m.name, upn: m.upn, homeOffice: emp.office, enabled: m.enabled, status: 'office_mismatch' });
      }
    }
  }

  // Order: office mismatches first (the real cleanup), then disabled, then unknowns.
  const rank: Record<DriftStatus, number> = { office_mismatch: 0, disabled_in_group: 1, no_home_office: 2, no_employee: 3 };
  findings.sort((a, b) => rank[a.status] - rank[b.status] || a.group.localeCompare(b.group));
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.status] = (counts[f.status] || 0) + 1;

  return { ok: true, findings, locationGroups, counts };
}
