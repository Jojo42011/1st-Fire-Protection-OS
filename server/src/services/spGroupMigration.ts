import { listGroupsWithMembers, updateGroupDisplayName } from './msGraphGroups';

/** Park every cloud-only SG-SP group under a suffix (default "-CLOUD") so the on-prem copies can take
 *  the clean names. Only touches cloud-only groups; synced ones and already-suffixed ones are skipped.
 *  Renaming changes only the displayName, not the object id, so current SharePoint access is intact. */
export async function renameCloudSpGroups(suffix: string): Promise<{
  ok: boolean; error?: string; suffix: string;
  renamed: { from: string; to: string }[]; skipped: { name: string; why: string }[];
}> {
  const sfx = suffix || '-CLOUD';
  const res = await listGroupsWithMembers('SG-SP');
  if (!res.ok) return { ok: false, error: res.error || 'could not read groups', suffix: sfx, renamed: [], skipped: [] };
  const renamed: { from: string; to: string }[] = [];
  const skipped: { name: string; why: string }[] = [];
  for (const g of res.groups) {
    if (g.syncedFromAD) { skipped.push({ name: g.name, why: 'already synced from AD' }); continue; }
    if (g.name.toLowerCase().endsWith(sfx.toLowerCase())) { skipped.push({ name: g.name, why: 'already suffixed' }); continue; }
    const to = g.name + sfx;
    // eslint-disable-next-line no-await-in-loop
    const r = await updateGroupDisplayName(g.id, to);
    if (r.ok) renamed.push({ from: g.name, to }); else skipped.push({ name: g.name, why: r.error || 'rename failed' });
  }
  return { ok: true, suffix: sfx, renamed, skipped };
}

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

/** AD sAMAccountName is capped at 20 chars. Keep the full name as CN/DisplayName, but derive a
 *  short, unique SAM when the group name is too long. */
function samFor(name: string, used: Set<string>): string {
  let sam = name.length <= 20 ? name : name.slice(0, 20);
  if (used.has(sam.toLowerCase())) {
    const stem = sam.slice(0, 17);
    let n = 2;
    while (used.has((stem + n).toLowerCase())) n++;
    sam = stem + n;
  }
  used.add(sam.toLowerCase());
  return sam;
}

export async function buildOnPremGroupPlan(ou: string): Promise<MigrationPlan> {
  const targetOu = (ou || '').trim();
  const res = await listGroupsWithMembers('SG-SP');
  if (!res.ok) return { ok: false, error: res.error || 'could not read groups', ou: targetOu, cloudGroups: 0, groups: [], script: '' };

  // only the cloud-only ones need rebuilding; anything already synced from AD is left alone
  const cloud = res.groups.filter((g) => !g.syncedFromAD).sort((a, b) => a.name.localeCompare(b.name));

  const groups: MigrationGroup[] = [];
  const usedSam = new Set<string>();
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
    // If the cloud copy was parked under a suffix (e.g. "-CLOUD"), the on-prem group takes the clean name.
    const cleanName = g.name.replace(/-CLOUD$/i, '');
    const users = g.members.filter((m) => m.type === 'user' || m.type === 'unknown');
    const withSam = users.filter((m) => m.sam);
    const noSam = users.filter((m) => !m.sam).map((m) => m.name || m.upn || '(unknown)');
    groups.push({ name: cleanName, members: users.length, resolved: withSam.length, unresolved: noSam });

    const sam = samFor(cleanName, usedSam);
    lines.push(`# ---- ${cleanName}  (${withSam.length} of ${users.length} members resolved) ----`);
    lines.push(`New-ADGroup -Name "${ps(cleanName)}" -SamAccountName "${ps(sam)}" -DisplayName "${ps(cleanName)}" -GroupScope Global -GroupCategory Security -Path $ou -ErrorAction Stop`);
    if (withSam.length) {
      const sams = withSam.map((m) => `"${ps(m.sam as string)}"`).join(',');
      lines.push(`Add-ADGroupMember -Identity "${ps(sam)}" -Members ${sams}`);
    }
    if (noSam.length) {
      lines.push(`# No on-prem account for: ${noSam.map((n) => ps(n)).join(', ')}  (add by hand if they should be in the group)`);
    }
    lines.push('');
  }

  if (!cloud.length) lines.push('# No cloud-only SG-SP groups found. Nothing to migrate.');

  return { ok: true, ou: targetOu, cloudGroups: cloud.length, groups, script: lines.join('\n') };
}
