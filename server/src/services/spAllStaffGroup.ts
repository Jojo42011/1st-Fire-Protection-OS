import { reconcileBambooAd } from './adBambooReconcile';

/**
 * SG-SP-AllStaff: a single security group holding every active employee, granted READ at the Shared
 * library root so everyone can traverse/navigate the drive (and OneDrive can walk the path down to the
 * folders their location/function group grants them). This replaces the old pile of per-office
 * "<Office> employees" site groups that used to sit on the root: one clean group instead of fifteen.
 *
 * Membership is the reconciled active-paired set (BambooHR is the source of truth for who is employed):
 * enabled AD accounts that pair to an ACTIVE BambooHR person via smart name matching. Leavers whose
 * account is still enabled are excluded. New hires flow in because provisioning adds SG-SP-AllStaff to
 * every new account; this script re-syncs the existing population and is safe to re-run.
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
  // Membership is the reconciled active-paired set: enabled AD accounts that pair to an ACTIVE
  // BambooHR employee (BambooHR is the source of truth for who is employed). This excludes leavers
  // whose account is still enabled, and uses smart name pairing (preferred name, nicknames, suffixes).
  const result = reconcileBambooAd();
  const sams = [...result.activePairedSams].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const noAccount = result.missingAccount.map((r) => r.name || r.upn || '').filter(Boolean);

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
