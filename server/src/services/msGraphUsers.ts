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
  licenseSkuIds: string[];
}

/** Every user in the directory (enabled and not), normalized. Paginated and bounded. Keyless-safe. */
export async function listAllUsers(): Promise<{ ok: boolean; error?: string; users: DirUser[] }> {
  if (!graphUsersConfigured()) return { ok: false, error: 'Microsoft Graph is not connected', users: [] };
  try {
    const token = await graphToken();
    if (!token) return { ok: false, error: 'could not acquire a Graph token', users: [] };
    const users: DirUser[] = [];
    let next: string | null = `https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,mail,givenName,surname,accountEnabled,assignedLicenses&$top=999`;
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
          licenseSkuIds: Array.isArray(u.assignedLicenses) ? u.assignedLicenses.map((l: any) => l.skuId).filter(Boolean) : [],
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

/** Map of license skuId -> friendly SKU part number (e.g. SPB -> "Microsoft 365 Business Premium").
 *  Needs Organization.Read.All or Directory.Read.All; if absent, returns an empty map (counts still
 *  work, names just show as the raw part number or a count). Keyless-safe. */
export async function listSubscribedSkus(): Promise<Record<string, string>> {
  if (!graphUsersConfigured()) return {};
  try {
    const token = await graphToken();
    if (!token) return {};
    const res = await fetch(`https://graph.microsoft.com/v1.0/subscribedSkus?$select=skuId,skuPartNumber`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return {};
    const j: any = await res.json().catch(() => ({}));
    const map: Record<string, string> = {};
    for (const s of j.value || []) if (s.skuId) map[s.skuId] = prettySku(s.skuPartNumber || s.skuId);
    return map;
  } catch {
    return {};
  }
}

// A few of the common SKU part numbers spelled out; anything unmapped shows its raw part number.
const SKU_NAMES: Record<string, string> = {
  SPB: 'Microsoft 365 Business Premium',
  O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Standard',
  O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  SPE_E3: 'Microsoft 365 E3',
  SPE_E5: 'Microsoft 365 E5',
  ENTERPRISEPACK: 'Office 365 E3',
  EXCHANGESTANDARD: 'Exchange Online (Plan 1)',
  EXCHANGEENTERPRISE: 'Exchange Online (Plan 2)',
  FLOW_FREE: 'Power Automate Free',
  POWER_BI_STANDARD: 'Power BI (free)',
};
function prettySku(part: string): string {
  return SKU_NAMES[part] || part;
}
