import { getDb } from '../db/index';

/**
 * SG-SP-AllStaff: a single security group holding every active employee, granted READ at the Shared
 * library root so everyone can traverse/navigate the drive (and OneDrive can walk the path down to the
 * folders their location/function group grants them). This replaces the old pile of per-office
 * "<Office> employees" site groups that used to sit on the root: one clean group instead of fifteen.
 *
 * Membership is the same active-employee -> AD-account join the distribution-list plan uses, so the
 * group tracks real staff. New hires flow in because provisioning adds SG-SP-AllStaff to every new
 * account; this script re-syncs the existing population and is safe to re-run.
 */

const DEFAULT_SP_OU = 'OU=SharePoint,OU=SECURITY,OU=GROUPS,OU=1FP,DC=ad,DC=1stfpservices,DC=com';
const GROUP_NAME = 'SG-SP-AllStaff';

const psq = (s: string) => `'${String(s || '').replace(/'/g, "''")}'`;

export interface AllStaffPlan {
  ok: boolean;
  group: string;
  ou: string;
  memberCount: number;
  noAccount: string[];
  script: string;
}

/** Resolve every active employee to at most one enabled AD account and return the SAM list + a
 *  create-and-populate PowerShell script for SG-SP-AllStaff. */
export function buildAllStaffGroupPlan(ou = DEFAULT_SP_OU): AllStaffPlan {
  const db = getDb();
  const adUsers = db.prepare(
    `SELECT sam, upn, email, given_name, surname FROM ad_users WHERE enabled = 1 AND sam IS NOT NULL AND sam != ''`
  ).all() as { sam: string; upn: string | null; email: string | null; given_name: string | null; surname: string | null }[];
  const byEmail = new Map<string, typeof adUsers[number]>();
  const byUpn = new Map<string, typeof adUsers[number]>();
  const bySam = new Map<string, typeof adUsers[number]>();
  const byName = new Map<string, typeof adUsers[number]>();
  const lc = (s: string | null | undefined) => String(s || '').toLowerCase().trim();
  for (const a of adUsers) {
    if (a.email) byEmail.set(lc(a.email), a);
    if (a.upn) byUpn.set(lc(a.upn), a);
    if (a.sam) bySam.set(lc(a.sam), a);
    if (a.given_name && a.surname) byName.set(lc(a.given_name) + '|' + lc(a.surname), a);
  }
  const emps = db.prepare(
    `SELECT legal_first_name AS first, legal_last_name AS last, work_email AS email, ad_username
       FROM employees WHERE employment_status NOT IN ('terminated', 'prehire')`
  ).all() as { first: string; last: string; email: string | null; ad_username: string | null }[];

  const usedSam = new Set<string>();
  const sams: string[] = [];
  const noAccount: string[] = [];
  for (const e of emps) {
    const hit =
      (e.email && (byEmail.get(lc(e.email)) || byUpn.get(lc(e.email)))) ||
      (e.ad_username && bySam.get(lc(e.ad_username))) ||
      byName.get(lc(e.first) + '|' + lc(e.last)) || null;
    if (hit && !usedSam.has(lc(hit.sam))) { usedSam.add(lc(hit.sam)); sams.push(hit.sam); }
    else if (!hit) noAccount.push(`${e.first || ''} ${e.last || ''}`.trim() || (e.email || ''));
  }
  sams.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const L: string[] = [];
  L.push('# Create SG-SP-AllStaff (if needed) and set its membership to every active employee, on-prem.');
  L.push('# Grants everyone traversal/read at the Shared drive root so navigation + OneDrive work.');
  L.push('# Run on a domain controller, then Start-ADSyncSyncCycle -PolicyType Delta on the AD Connect');
  L.push('# server. Idempotent: existing members are left alone, only missing ones are added.');
  L.push('Import-Module ActiveDirectory');
  L.push('');
  L.push(`$Group = ${psq(GROUP_NAME)}`);
  L.push(`$OU    = ${psq(ou)}`);
  L.push('');
  L.push('if (-not (Get-ADGroup -Filter "SamAccountName -eq \'$Group\'" -ErrorAction SilentlyContinue)) {');
  L.push('  New-ADGroup -Name $Group -SamAccountName $Group -DisplayName $Group -GroupScope Global -GroupCategory Security -Path $OU -Description "All active staff - SharePoint drive traversal (read at Shared root)"');
  L.push('  Write-Host "Created $Group"');
  L.push('}');
  L.push('');
  L.push('$members = @(');
  for (const s of sams) L.push(`  ${psq(s)}`);
  L.push(')');
  L.push('');
  L.push('$existing = @(Get-ADGroupMember -Identity $Group -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SamAccountName)');
  L.push('$toAdd = $members | Where-Object { $existing -notcontains $_ }');
  L.push('if ($toAdd) { Add-ADGroupMember -Identity $Group -Members $toAdd; Write-Host "Added $($toAdd.Count) members" }');
  L.push('else { Write-Host "No new members to add" }');
  L.push('Write-Host "$Group now targets $($members.Count) active employees. Run a delta sync next."');

  return { ok: true, group: GROUP_NAME, ou, memberCount: sams.length, noAccount, script: L.join('\n') };
}
