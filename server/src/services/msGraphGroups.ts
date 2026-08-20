/**
 * Microsoft Graph: security-group membership, for onboarding access provisioning.
 *
 * Reuses the same Entra app-registration credentials as the mail and license integrations
 * (MS_GRAPH_TENANT / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET). Adding a user to a group requires
 * the **GroupMember.ReadWrite.All** (or Group.ReadWrite.All) application permission granted to that
 * app with admin consent. Keyless / permissionless-safe: every call returns { ok, error } instead of
 * throwing, so a missing grant never crashes onboarding.
 */
import { graphToken } from './licenseSources';

export function graphConfigured(): boolean {
  return !!(process.env.MS_GRAPH_TOKEN || (process.env.MS_GRAPH_TENANT && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET));
}

/** Resolve a user's directory object id from a UPN or email. */
async function resolveUserId(token: string, upn: string): Promise<string | null> {
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(upn)}?$select=id`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { id?: string };
  return j.id || null;
}

/** Look up a security group's object id by display name (when only the name is known). */
export async function findGroupIdByName(name: string): Promise<string | null> {
  if (!graphConfigured()) return null;
  try {
    const token = await graphToken();
    if (!token) return null;
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/groups?$filter=${encodeURIComponent(`displayName eq '${name.replace(/'/g, "''")}'`)}&$select=id&$top=1`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { value?: { id: string }[] };
    return j.value && j.value[0] ? j.value[0].id : null;
  } catch {
    return null;
  }
}

/**
 * Add a user (by UPN/email) to an Entra security group. Pass the group's object id when known, else
 * its display name and it is resolved first. Idempotent from Graph's side (adding an existing member
 * returns 400 "already exists", which is treated as success).
 */
export async function addUserToGroup(upn: string, opts: { groupId?: string | null; groupName?: string | null }): Promise<{ ok: boolean; error?: string; already?: boolean }> {
  if (!graphConfigured()) return { ok: false, error: 'Microsoft Graph is not connected' };
  if (!upn) return { ok: false, error: 'no user principal name / email given' };
  try {
    const token = await graphToken();
    if (!token) return { ok: false, error: 'could not acquire a Graph token' };
    const groupId = opts.groupId || (opts.groupName ? await findGroupIdByName(opts.groupName) : null);
    if (!groupId) return { ok: false, error: `could not resolve group ${opts.groupName || ''}`.trim() };
    const userId = await resolveUserId(token, upn);
    if (!userId) return { ok: false, error: `no directory user for ${upn}` };
    const res = await fetch(`https://graph.microsoft.com/v1.0/groups/${groupId}/members/$ref`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` }),
    });
    if (res.status === 204 || res.ok) return { ok: true };
    const body = await res.text();
    // Graph returns 400 with "already exist" when the user is already a member.
    if (res.status === 400 && /already exist/i.test(body)) return { ok: true, already: true };
    return { ok: false, error: `graph addMember ${res.status}: ${body}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
