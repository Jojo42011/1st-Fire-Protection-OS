import { graphToken } from './licenseSources';
import { findGroupIdByName, addUserToGroup, isGroupOnPrem, groupHasMembers } from './msGraphGroups';
import { removeSharePermission } from './spDirectShares';

/**
 * Convert a SharePoint folder from ad-hoc direct sharing to group-based access.
 *
 * For one folder: ensure a security group exists (create it if asked), grant that group Edit access
 * to the folder, add the folder's active-employee grantees into the group, then revoke the specified
 * direct-share permissions (org-wide/anonymous links, and the individual grants now covered by the
 * group). Everything runs on the app's Graph app-only credentials (Sites.ReadWrite.All +
 * Group.ReadWrite.All). Each step is best-effort and reported, so a partial failure is visible.
 */

const nick = (name: string) => name.replace(/[^a-z0-9]/gi, '').slice(0, 60) || 'group';

/** Create an Entra security group (mail-disabled). Returns its id. */
async function createSecurityGroup(displayName: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const token = await graphToken();
  if (!token) return { ok: false, error: 'Microsoft Graph is not connected' };
  const res = await fetch('https://graph.microsoft.com/v1.0/groups', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName, mailEnabled: false, mailNickname: nick(displayName), securityEnabled: true }),
  });
  if (!res.ok) return { ok: false, error: `create group ${res.status}: ${(await res.text()).slice(0, 180)}` };
  const j = await res.json();
  return { ok: true, id: j.id };
}

/** Grant a security group a role (default write) on a drive item. */
async function grantGroupToItem(driveId: string, itemId: string, groupId: string, role = 'write'): Promise<{ ok: boolean; error?: string }> {
  const token = await graphToken();
  if (!token) return { ok: false, error: 'Microsoft Graph is not connected' };
  const res = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ recipients: [{ objectId: groupId }], roles: [role], requireSignIn: true, sendInvitation: false }),
  });
  if (!res.ok) return { ok: false, error: `grant group ${res.status}: ${(await res.text()).slice(0, 180)}` };
  return { ok: true };
}

export interface ConvertResult {
  ok: boolean;
  error?: string;
  groupId?: string;
  groupName: string;
  created: boolean;
  granted: boolean;
  added: number;
  removed: number;
  removedPermIds: string[]; // the direct-share permissions actually revoked (to prune the stored scan)
  membersOnPrem: boolean;   // group is synced from AD; membership was NOT touched here (managed on-prem)
  skippedAdds: number;      // members we did not add because the group is on-prem
  failures: string[];
}

export async function convertFolder(opts: {
  driveId: string; itemId: string; groupName: string; createGroup: boolean;
  addUpns: string[]; removePermIds: string[]; role?: string;
}): Promise<ConvertResult> {
  const out: ConvertResult = { ok: false, groupName: opts.groupName, created: false, granted: false, added: 0, removed: 0, removedPermIds: [], membersOnPrem: false, skippedAdds: 0, failures: [] };
  if (!opts.driveId || !opts.itemId || !opts.groupName) return { ...out, error: 'driveId, itemId and groupName are required' };

  // 1. Resolve or create the group.
  let groupId = await findGroupIdByName(opts.groupName);
  if (!groupId) {
    if (!opts.createGroup) return { ...out, error: `group "${opts.groupName}" not found (and create was not requested)` };
    const c = await createSecurityGroup(opts.groupName);
    if (!c.ok || !c.id) return { ...out, error: `could not create group: ${c.error}` };
    groupId = c.id; out.created = true;
  }
  out.groupId = groupId;

  // 2. Grant the group access to the folder.
  const g = await grantGroupToItem(opts.driveId, opts.itemId, groupId, opts.role || 'write');
  if (!g.ok) { out.failures.push(`grant: ${g.error}`); }
  else out.granted = true;

  // 3. Add the active-employee grantees to the group. A group synced from on-prem AD has its
  //    membership mastered on-prem: Graph cannot add members to it, so we skip the adds here and
  //    the caller sets membership in AD instead (Add-ADGroupMember). Cloud-only groups still add here.
  const onPrem = await isGroupOnPrem(groupId);
  out.membersOnPrem = onPrem;
  if (onPrem) {
    out.skippedAdds = (opts.addUpns || []).filter(Boolean).length;
  } else {
    for (const upn of opts.addUpns || []) {
      if (!upn) continue;
      // eslint-disable-next-line no-await-in-loop
      const a = await addUserToGroup(upn, { groupId });
      if (a.ok || a.already) out.added++; else out.failures.push(`add ${upn}: ${a.error}`);
    }
  }

  // 4. Revoke the direct-share permissions we are replacing. Only do this once the group is granted,
  //    so access is never dropped to zero. For an on-prem group, refuse to revoke if the group has
  //    no members yet: membership is set in AD and had not synced, and revoking would strand people.
  if (out.granted && onPrem && !(await groupHasMembers(groupId))) {
    out.failures.push('did not revoke direct shares: this on-prem group has no members yet. Set membership in AD (Add-ADGroupMember) and let it sync, then convert.');
    out.ok = false;
    return out;
  }
  if (out.granted) {
    for (const permId of opts.removePermIds || []) {
      if (!permId) continue;
      // eslint-disable-next-line no-await-in-loop
      const r = await removeSharePermission(opts.driveId, opts.itemId, permId);
      if (r.ok) { out.removed++; out.removedPermIds.push(permId); } else out.failures.push(`revoke ${permId}: ${r.error}`);
    }
  } else {
    out.failures.push('skipped revoking direct shares because the group grant failed (access preserved)');
  }

  out.ok = out.granted && out.failures.length === 0;
  return out;
}
