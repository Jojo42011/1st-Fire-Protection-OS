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

/** A directory group, normalized with a human-readable kind. mailbox=true means membership also
 *  grants a shared inbox (a Microsoft 365 group, a distribution list, or a mail-enabled security
 *  group), which is how most "shared mailbox" access is actually granted. */
export interface DirGroup { id: string; name: string; kind: string; mail: string | null; mailbox: boolean }
function classifyGroup(g: any): DirGroup {
  const types: string[] = Array.isArray(g.groupTypes) ? g.groupTypes : [];
  const unified = types.includes('Unified');
  const sec = !!g.securityEnabled, mail = !!g.mailEnabled;
  let kind = 'Security';
  if (unified) kind = 'Microsoft 365';
  else if (sec && mail) kind = 'Mail-enabled security';
  else if (mail) kind = 'Distribution';
  return { id: g.id, name: g.displayName || g.mail || g.id, kind, mail: g.mail || null, mailbox: unified || mail };
}
async function collect(url: string): Promise<any[]> {
  const token = await graphToken();
  if (!token) return [];
  const out: any[] = [];
  let next: string | null = url;
  let guard = 0;
  while (next && out.length < 4000 && guard < 40) {
    const res: Response = await fetch(next, { headers: { authorization: `Bearer ${token}`, consistencylevel: 'eventual' } });
    if (!res.ok) break;
    const j: any = await res.json().catch(() => ({}));
    for (const v of j.value || []) out.push(v);
    next = j['@odata.nextLink'] || null;
    guard++;
  }
  return out;
}

/** Every group in the directory (security, Microsoft 365, distribution), normalized. Needs the
 *  already-granted GroupMember.Read.All (part of GroupMember.ReadWrite.All). Keyless-safe. */
export async function listAllGroups(): Promise<{ ok: boolean; error?: string; groups: DirGroup[] }> {
  if (!graphConfigured()) return { ok: false, error: 'Microsoft Graph is not connected', groups: [] };
  try {
    const rows = await collect(`https://graph.microsoft.com/v1.0/groups?$select=id,displayName,securityEnabled,mailEnabled,groupTypes,mail&$top=999`);
    return { ok: true, groups: rows.map(classifyGroup).sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (err) {
    return { ok: false, error: (err as Error).message, groups: [] };
  }
}

/** The groups a specific user belongs to (direct memberships). Keyless-safe; returns [] on any
 *  failure with the reason. */
export async function listUserGroups(upn: string): Promise<{ ok: boolean; error?: string; groups: DirGroup[] }> {
  if (!graphConfigured()) return { ok: false, error: 'Microsoft Graph is not connected', groups: [] };
  if (!upn) return { ok: false, error: 'no user principal name / email given', groups: [] };
  try {
    const rows = await collect(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(upn)}/memberOf?$select=id,displayName,securityEnabled,mailEnabled,groupTypes,mail&$top=999`);
    const groups = rows.filter((r) => r['@odata.type'] === '#microsoft.graph.group').map(classifyGroup);
    return { ok: true, groups: groups.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (err) {
    return { ok: false, error: (err as Error).message, groups: [] };
  }
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

/**
 * Remove a user (by UPN/email) from an Entra security group. Idempotent: removing someone who is not
 * a member (Graph 404) is treated as success, so a revoke never fails just because it already ran.
 */
export async function removeUserFromGroup(upn: string, opts: { groupId?: string | null; groupName?: string | null }): Promise<{ ok: boolean; error?: string; already?: boolean }> {
  if (!graphConfigured()) return { ok: false, error: 'Microsoft Graph is not connected' };
  if (!upn) return { ok: false, error: 'no user principal name / email given' };
  try {
    const token = await graphToken();
    if (!token) return { ok: false, error: 'could not acquire a Graph token' };
    const groupId = opts.groupId || (opts.groupName ? await findGroupIdByName(opts.groupName) : null);
    if (!groupId) return { ok: false, error: `could not resolve group ${opts.groupName || ''}`.trim() };
    const userId = await resolveUserId(token, upn);
    if (!userId) return { ok: false, error: `no directory user for ${upn}` };
    const res = await fetch(`https://graph.microsoft.com/v1.0/groups/${groupId}/members/${userId}/$ref`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 204 || res.ok) return { ok: true };
    if (res.status === 404) return { ok: true, already: true }; // not a member anymore
    const body = await res.text();
    return { ok: false, error: `graph removeMember ${res.status}: ${body}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
