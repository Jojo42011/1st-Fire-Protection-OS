import { listGroupsWithMembers } from './msGraphGroups';
import { buildEmployeeIndex, matchAdToEmployee, EmpRow } from './adAudit';
import { getDb } from '../db/index';

/**
 * SharePoint access audit for executives.
 *
 * Pulls every SG-SP-* security group and its members from Entra, matches each member to their
 * BambooHR employee record, and lays access next to title and location so mismatches jump out:
 *   - a person sitting in a LOCATION group that is not their home office (access drift),
 *   - a DISABLED account still holding SharePoint access,
 *   - a member with no matching employee (external, service, or stale account).
 *
 * A group is treated as a location group only when its name suffix matches a real employee office;
 * everything else (Sales, Accounting, Management, ...) is a function group and is not office-checked.
 */

const norm = (v: string | null | undefined): string => (v || '').trim().toLowerCase();

/** Tolerant office match: exact, or a containment either way with a 4-char floor so short tokens
 *  (e.g. "fp") do not match everything. Mirrors the group-vs-office drift matcher. */
function officeMatches(officeNorm: string, suffixNorm: string): boolean {
  if (!officeNorm || !suffixNorm) return false;
  if (officeNorm === suffixNorm) return true;
  if (suffixNorm.length >= 4 && officeNorm.includes(suffixNorm)) return true;
  if (officeNorm.length >= 4 && suffixNorm.includes(officeNorm)) return true;
  return false;
}

const empTitle = (e: EmpRow | undefined): string | null => (e ? e.job_position || e.public_job_title || null : null);
const empName = (e: EmpRow): string => [e.legal_first_name, e.legal_last_name].filter(Boolean).join(' ').trim();

export interface AuditMember {
  name: string | null;
  upn: string | null;
  enabled: boolean | null;
  matched: boolean;
  title: string | null;
  office: string | null;
  department: string | null;
  status: string | null;       // employment_status
  locationMismatch: boolean;    // in a location group that is not their office
}

export interface AuditGroup {
  group: string;
  suffix: string;               // name after the SG-SP- prefix
  kind: string;                 // Security / Mail-enabled security / ...
  syncedFromAD: boolean;        // already an on-prem-synced group
  isLocation: boolean;
  location: string | null;      // the office it represents, when a location group
  memberCount: number;
  matchedCount: number;
  mismatchCount: number;
  disabledCount: number;
  members: AuditMember[];
}

export interface AuditPerson {
  name: string | null;
  upn: string | null;
  matched: boolean;
  title: string | null;
  office: string | null;
  department: string | null;
  status: string | null;
  enabled: boolean | null;
  groups: string[];
  locationGroups: string[];
  mismatchGroups: string[];     // location groups that are not their office
  flags: string[];
}

export interface SpAccessAudit {
  ok: true;
  generatedAt: string;
  prefix: string;
  summary: {
    groups: number;
    locationGroups: number;
    functionGroups: number;
    syncedFromAD: number;
    people: number;
    grants: number;              // total group memberships (person-in-group rows)
    matchedMembers: number;
    unmatchedMembers: number;
    locationMismatches: number;  // grants where person is in a location group != their office
    disabledWithAccess: number;  // distinct disabled people still in a group
  };
  groups: AuditGroup[];
  people: AuditPerson[];
}

/** The removals implied by the audit: every membership held by a disabled, non-employee, or
 *  no-longer-active account. Same definition the cleanup screen and the removal script use. */
export function flaggedRemovals(audit: SpAccessAudit): { group: string; upn: string; name: string | null; reason: string }[] {
  const INACTIVE = new Set(['terminated', 'prehire', 'inactive', 'offboarding']);
  const out: { group: string; upn: string; name: string | null; reason: string }[] = [];
  for (const g of audit.groups) {
    for (const m of g.members) {
      let reason = '';
      if (m.enabled === false) reason = 'Disabled account';
      else if (!m.matched) reason = 'Not in BambooHR';
      else if (m.status && INACTIVE.has(m.status.toLowerCase())) reason = `Not active (${m.status})`;
      if (reason && m.upn) out.push({ group: g.group, upn: m.upn, name: m.name, reason });
    }
  }
  return out;
}

export async function spAccessAudit(prefix = 'SG-SP-', generatedAt = new Date().toISOString()): Promise<{ ok: false; error: string } | SpAccessAudit> {
  const res = await listGroupsWithMembers(prefix);
  if (!res.ok) return { ok: false, error: res.error || 'could not read groups' };

  const idx = buildEmployeeIndex();
  // The set of real offices, to decide which group suffixes are locations.
  const officesNorm = Array.from(new Set(idx.all.map((e) => norm(e.office)).filter(Boolean)));

  const groups: AuditGroup[] = [];
  // Aggregate per person across groups.
  const people = new Map<string, AuditPerson>();
  const keyFor = (upn: string | null, name: string | null) => norm(upn) || norm(name) || 'unknown';

  let grants = 0, matchedMembers = 0, unmatchedMembers = 0, locationMismatches = 0;
  const disabledPeople = new Set<string>();

  for (const g of res.groups) {
    const suffix = g.name.replace(new RegExp(`^${prefix}`, 'i'), '');
    const suffixNorm = norm(suffix);
    const isLocation = officesNorm.some((o) => officeMatches(o, suffixNorm));
    const members: AuditMember[] = [];
    let matchedCount = 0, mismatchCount = 0, disabledCount = 0;

    for (const m of g.members) {
      grants++;
      const emp = matchAdToEmployee({ upn: m.upn, email: m.upn }, idx);
      const matched = !!emp;
      if (matched) matchedMembers++; else unmatchedMembers++;
      const office = emp ? emp.office : null;
      const locationMismatch = isLocation && matched && !officeMatches(norm(office), suffixNorm);
      if (matched) matchedCount++;
      if (locationMismatch) { mismatchCount++; locationMismatches++; }
      if (m.enabled === false) { disabledCount++; disabledPeople.add(keyFor(m.upn, m.name)); }

      members.push({
        name: m.name || (emp ? empName(emp) : null),
        upn: m.upn,
        enabled: m.enabled,
        matched,
        title: empTitle(emp),
        office,
        department: emp ? emp.department : null,
        status: emp ? emp.employment_status : null,
        locationMismatch,
      });

      // person aggregate
      const k = keyFor(m.upn, m.name);
      let p = people.get(k);
      if (!p) {
        p = {
          name: m.name || (emp ? empName(emp) : null),
          upn: m.upn,
          matched,
          title: empTitle(emp),
          office,
          department: emp ? emp.department : null,
          status: emp ? emp.employment_status : null,
          enabled: m.enabled,
          groups: [],
          locationGroups: [],
          mismatchGroups: [],
          flags: [],
        };
        people.set(k, p);
      }
      p.groups.push(g.name);
      if (isLocation) p.locationGroups.push(g.name);
      if (locationMismatch) p.mismatchGroups.push(g.name);
    }

    groups.push({
      group: g.name,
      suffix,
      kind: g.kind,
      syncedFromAD: g.syncedFromAD,
      isLocation,
      location: isLocation ? suffix : null,
      memberCount: g.members.length,
      matchedCount,
      mismatchCount,
      disabledCount,
      members: members.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    });
  }

  // Derive per-person flags for the executive read.
  for (const p of people.values()) {
    if (!p.matched) p.flags.push('No matching employee (external / service / stale)');
    if (p.enabled === false) p.flags.push('Account disabled but still has access');
    if (p.mismatchGroups.length) p.flags.push(`In ${p.mismatchGroups.length} location group(s) outside their office`);
    if (p.locationGroups.length > 1) p.flags.push('In more than one location group');
  }

  const peopleArr = Array.from(people.values()).sort((a, b) => {
    // Flagged people first, then by name.
    if (!!b.flags.length !== !!a.flags.length) return b.flags.length ? 1 : -1;
    return (a.name || '').localeCompare(b.name || '');
  });

  return {
    ok: true,
    generatedAt,
    prefix,
    summary: {
      groups: groups.length,
      locationGroups: groups.filter((g) => g.isLocation).length,
      functionGroups: groups.filter((g) => !g.isLocation).length,
      syncedFromAD: groups.filter((g) => g.syncedFromAD).length,
      people: people.size,
      grants,
      matchedMembers,
      unmatchedMembers,
      locationMismatches,
      disabledWithAccess: disabledPeople.size,
    },
    groups: groups.sort((a, b) => a.group.localeCompare(b.group)),
    people: peopleArr,
  };
}
