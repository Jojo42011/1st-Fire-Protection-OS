import { listGroupsWithMembers } from './msGraphGroups';

/**
 * Recreate the cloud-only SharePoint security groups (SG-SP-*) as on-prem AD groups.
 *
 * These groups were made directly in Entra by mistake; in this tenant AD is the source of truth and
 * SharePoint groups must sync UP from on-prem. You cannot move a cloud group on-prem, so the fix is to
 * rebuild each one in the SharePoint OU with the same name and members, let Azure AD Connect sync it,
 * then retire the cloud copy. This generates the PowerShell to do the rebuild, resolving each Entra
 * member to its on-prem account (onPremisesSamAccountName) so Add-ADGroupMember is unambiguous.
 */

export interface MigrationGroup {
  name: string;
  members: number;
  resolved: number;         // members with an on-prem SAM
  unresolved: string[];     // member display names with no on-prem account (cannot be added by script)
}

export interface MigrationPlan {
  ok: boolean;
  error?: string;
  ou: string;
  cloudGroups: number;
  groups: MigrationGroup[];
  script: string;
}

const ps = (s: string) => String(s || '').replace(/`/g, '``').replace(/"/g, '`"');

export async function buildOnPremGroupPlan(ou: string): Promise<MigrationPlan> {
  const targetOu = (ou || '').trim();
  const res = await listGroupsWithMembers('SG-SP');
  if (!res.ok) return { ok: false, error: res.error || 'could not read groups', ou: targetOu, cloudGroups: 0, groups: [], script: '' };

  // only the cloud-only ones need rebuilding; anything already synced from AD is left alone
  const cloud = res.groups.filter((g) => !g.syncedFromAD).sort((a, b) => a.name.localeCompare(b.name));

  const groups: MigrationGroup[] = [];
  const lines: string[] = [];
  lines.push('# Recreate cloud-only SharePoint security groups (SG-SP-*) as on-prem AD groups.');
  lines.push('# Review, then run on a domain controller. Members are matched by on-prem sAMAccountName.');
  lines.push('# After it finishes, force a sync on the Azure AD Connect server:');
  lines.push('#   Start-ADSyncSyncCycle -PolicyType Delta');
  lines.push('# Then re-point SharePoint at the newly-synced groups and delete the old cloud copies.');
  lines.push('');
  lines.push(`$ou = "${ps(targetOu)}"`);
  lines.push('');

  for (const g of cloud) {
    const users = g.members.filter((m) => m.type === 'user' || m.type === 'unknown');
    const withSam = users.filter((m) => m.sam);
    const noSam = users.filter((m) => !m.sam).map((m) => m.name || m.upn || '(unknown)');
    groups.push({ name: g.name, members: users.length, resolved: withSam.length, unresolved: noSam });

    lines.push(`# ---- ${g.name}  (${withSam.length} of ${users.length} members resolved) ----`);
    lines.push(`New-ADGroup -Name "${ps(g.name)}" -SamAccountName "${ps(g.name)}" -GroupScope Global -GroupCategory Security -Path $ou -ErrorAction Stop`);
    if (withSam.length) {
      const sams = withSam.map((m) => `"${ps(m.sam as string)}"`).join(',');
      lines.push(`Add-ADGroupMember -Identity "${ps(g.name)}" -Members ${sams}`);
    }
    if (noSam.length) {
      lines.push(`# No on-prem account for: ${noSam.map((n) => ps(n)).join(', ')}  (add by hand if they should be in the group)`);
    }
    lines.push('');
  }

  if (!cloud.length) lines.push('# No cloud-only SG-SP groups found. Nothing to migrate.');

  return { ok: true, ou: targetOu, cloudGroups: cloud.length, groups, script: lines.join('\n') };
}
