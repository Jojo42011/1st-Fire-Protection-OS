import { graphToken } from './licenseSources';
import { findGroupIdByName } from './msGraphGroups';

/**
 * Grant a set of security groups (e.g. the HQ function groups SG-SP-Accounting / Services /
 * Management) to a site's top-level office folders, so cross-functional staff keep folder access
 * through their function group instead of being members of each location group. Granting a group to
 * a drive item is a SharePoint permission (Graph invite), which works fine on on-prem-synced groups
 * (unlike membership, which must be managed on-prem).
 */

async function gget(url: string, token: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (!res.ok) throw new Error(`graph ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }
  throw new Error('graph throttled after retries');
}

async function grantGroupToItem(driveId: string, itemId: string, groupId: string, token: string, role = 'write'): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ recipients: [{ objectId: groupId }], roles: [role], requireSignIn: true, sendInvitation: false }),
  });
  if (!res.ok) return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 160)}` };
  return { ok: true };
}

const nameKey = (s: string) =>
  (s || '').replace(/1st\s*fire\s*protection|1st\s*fp|1stfp/gi, ' ').replace(/\b(shared|documents?|folder|files?|general)\b/gi, ' ').replace(/[^a-z0-9]/gi, '').toLowerCase();

export interface LocationGrantResult {
  ok: boolean;
  error?: string;
  groups: { name: string; id: string | null }[];
  folders: { folder: string; drive: string; granted: string[]; failures: string[] }[];
}

/**
 * Grant `groupNames` to each top-level folder whose name matches one of `folderTokens` (a token is a
 * location key like "austin"). Empty folderTokens = every top-level folder.
 */
export async function grantGroupsToTopFolders(site: string, groupNames: string[], folderTokens: string[]): Promise<LocationGrantResult> {
  const token = await graphToken();
  if (!token) return { ok: false, error: 'Microsoft Graph is not connected', groups: [], folders: [] };
  const out: LocationGrantResult = { ok: true, groups: [], folders: [] };

  // Resolve the groups to object ids once.
  for (const name of groupNames) { const id = await findGroupIdByName(name); out.groups.push({ name, id }); }
  const usable = out.groups.filter((g) => g.id) as { name: string; id: string }[];
  if (!usable.length) return { ok: false, error: 'none of the groups resolved', groups: out.groups, folders: [] };

  // Resolve the site and its drives.
  const u = new URL(site);
  const path = u.pathname.replace(/\/$/, '');
  const s = await gget(`https://graph.microsoft.com/v1.0/sites/${u.host}:${path}?$select=id`, token);
  const dv = await gget(`https://graph.microsoft.com/v1.0/sites/${s.id}/drives?$select=id,name`, token);
  const tokens = folderTokens.map((t) => t.toLowerCase()).filter(Boolean);

  for (const d of (dv.value || []) as { id: string; name: string }[]) {
    const kids = await gget(`https://graph.microsoft.com/v1.0/drives/${d.id}/root/children?$select=id,name,folder&$top=400`, token);
    for (const it of (kids.value || [])) {
      if (!it.folder) continue;
      const nk = nameKey(it.name);
      if (tokens.length && !tokens.some((t) => nk.includes(t) || t.includes(nk))) continue;
      const granted: string[] = [];
      const failures: string[] = [];
      for (const g of usable) {
        // eslint-disable-next-line no-await-in-loop
        const r = await grantGroupToItem(d.id, it.id, g.id, token);
        if (r.ok) granted.push(g.name); else failures.push(`${g.name}: ${r.error}`);
      }
      out.folders.push({ folder: it.name, drive: d.name, granted, failures });
    }
  }
  return out;
}
