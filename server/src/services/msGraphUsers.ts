/**
 * Microsoft Graph: the user directory, so Entra (not BambooHR) is the source of truth for identity.
 *
 * Reuses the shared Entra app credentials. Listing users needs the **User.Read.All** (or
 * Directory.Read.All) application permission granted with admin consent. Keyless- and
 * permissionless-safe: returns { ok, ... } instead of throwing.
 */
import { graphToken } from './licenseSources';

export function graphUsersConfigured(): boolean {
  return !!(process.env.MS_GRAPH_TOKEN || (process.env.MS_GRAPH_TENANT && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET));
}

export interface DirUser {
  id: string;
  upn: string | null;
  mail: string | null;
  displayName: string | null;
  first: string | null;
  last: string | null;
  enabled: boolean;
}

/** Every user in the directory (enabled and not), normalized. Paginated and bounded. Keyless-safe. */
export async function listAllUsers(): Promise<{ ok: boolean; error?: string; users: DirUser[] }> {
  if (!graphUsersConfigured()) return { ok: false, error: 'Microsoft Graph is not connected', users: [] };
  try {
    const token = await graphToken();
    if (!token) return { ok: false, error: 'could not acquire a Graph token', users: [] };
    const users: DirUser[] = [];
    let next: string | null = `https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,mail,givenName,surname,accountEnabled&$top=999`;
    let guard = 0;
    while (next && users.length < 8000 && guard < 40) {
      const res: Response = await fetch(next, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'Graph returned Access Denied. Add the User.Read.All application permission to the app registration and grant admin consent.', users: [] };
        return { ok: false, error: `graph users ${res.status}: ${text.slice(0, 200)}`, users: [] };
      }
      const j: any = await res.json().catch(() => ({}));
      for (const u of j.value || []) {
        users.push({
          id: u.id,
          upn: u.userPrincipalName || null,
          mail: u.mail || null,
          displayName: u.displayName || null,
          first: u.givenName || null,
          last: u.surname || null,
          enabled: u.accountEnabled !== false,
        });
      }
      next = j['@odata.nextLink'] || null;
      guard++;
    }
    return { ok: true, users };
  } catch (err) {
    return { ok: false, error: (err as Error).message, users: [] };
  }
}
