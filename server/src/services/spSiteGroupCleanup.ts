import { graphToken } from './licenseSources';

/**
 * Find (and remove) grants to classic SharePoint site groups on a site's folders. After converting
 * to the modern on-prem SG-SP groups, the old SharePoint groups (ACCT, SAFETY, "<Office> employees",
 * etc.) are redundant. We keep the default site groups (Owners/Members/Visitors) and every modern
 * Entra group (the SG-SP-* grants show as grantedToV2.group, not siteGroup), and flag the rest.
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

// Default site groups to keep: names ending in Owners/Members/Visitors (e.g. "Shared Owners").
const isDefaultSiteGroup = (name: string) => /\b(owners|members|visitors)$/i.test((name || '').trim());

export interface SiteGroupGrant {
  driveId: string; itemId: string; path: string; item: string;
  permId: string; groupName: string; roles: string; inherited: boolean;
}

export async function findSiteGroupGrants(site: string, maxDepth: number | null = 2): Promise<{ ok: boolean; error?: string; coverage: { folders: number }; grants: SiteGroupGrant[] }> {
  const token = await graphToken();
  if (!token) return { ok: false, error: 'Microsoft Graph is not connected', coverage: { folders: 0 }, grants: [] };
  try {
    const u = new URL(site);
    const path = u.pathname.replace(/\/$/, '');
    const s = await gget(`https://graph.microsoft.com/v1.0/sites/${u.host}:${path}?$select=id`, token);
    const dv = await gget(`https://graph.microsoft.com/v1.0/sites/${s.id}/drives?$select=id,name`, token);
    const grants: SiteGroupGrant[] = [];
    let folders = 0;
    const queue: { driveId: string; id: string; path: string; depth: number }[] =
      (dv.value || []).map((d: any) => ({ driveId: d.id, id: 'root', path: `/${d.name}`, depth: 0 }));
    let guard = 0;
    while (queue.length && guard++ < 4000) {
      const cur = queue.shift()!;
      folders++;
      // children
      let url: string | null = `https://graph.microsoft.com/v1.0/drives/${cur.driveId}/items/${cur.id}/children?$select=id,name,folder&$top=200`;
      while (url) {
        // eslint-disable-next-line no-await-in-loop
        const page: any = await gget(url, token);
        for (const it of (page.value || [])) {
          if (!it.folder) continue;
          const childPath = `${cur.path}/${it.name}`;
          // permissions on this folder
          // eslint-disable-next-line no-await-in-loop
          const perms: any = await gget(`https://graph.microsoft.com/v1.0/drives/${cur.driveId}/items/${it.id}/permissions?$top=100`, token);
          for (const p of (perms.value || [])) {
            const principals = [p.grantedToV2, ...(p.grantedToIdentitiesV2 || [])].filter(Boolean);
            for (const gp of principals) {
              const sg = gp.siteGroup;
              if (!sg) continue;                                // only classic SharePoint site groups
              if (isDefaultSiteGroup(sg.displayName)) continue; // keep Owners/Members/Visitors
              grants.push({
                driveId: cur.driveId, itemId: it.id, path: cur.path, item: it.name,
                permId: p.id, groupName: sg.displayName || sg.loginName || '(unknown)',
                roles: (p.roles || []).join('/'), inherited: !!p.inheritedFrom,
              });
            }
          }
          if (maxDepth == null || cur.depth + 1 <= maxDepth) queue.push({ driveId: cur.driveId, id: it.id, path: childPath, depth: cur.depth + 1 });
        }
        url = page['@odata.nextLink'] || null;
      }
    }
    return { ok: true, coverage: { folders }, grants };
  } catch (e) {
    return { ok: false, error: (e as Error).message, coverage: { folders: 0 }, grants: [] };
  }
}

// Old SharePoint group name -> modern SG-SP token. Most map by name; a couple of abbreviations need
// an explicit alias.
const ALIAS: Record<string, string> = { acct: 'accounting', mgmt: 'management' };
function modernToken(oldName: string): string {
  let n = (oldName || '')
    .replace(/\bemployees?\b/gi, ' ')
    .replace(/^sp\b/i, ' ')
    .replace(/1st\s*fp|1st\s*fire\s*protection|1stfp/gi, ' ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/,?\s*llc\.?/gi, ' ');
  const k = n.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return ALIAS[k] || k;
}

async function grantGroupToItem(driveId: string, itemId: string, groupId: string, token: string, role: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ recipients: [{ objectId: groupId }], roles: [role], requireSignIn: true, sendInvitation: false }),
  });
  if (!res.ok) return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 140)}` };
  return { ok: true };
}

export interface ReplaceResult {
  ok: boolean; error?: string; dryRun: boolean;
  actions: { path: string; item: string; oldGroup: string; modern: string | null; roles: string; granted?: boolean; removed?: boolean; note?: string }[];
  granted: number; removed: number; skipped: number;
}

/**
 * For every classic SharePoint site-group grant on the site's folders, grant the matching modern
 * SG-SP group (same role) then remove the old grant. dryRun reports the mapping without changing.
 * Roles map: owner->owner, otherwise write (edit). "restrictedView" becomes read.
 */
export async function replaceSiteGroupsWithModern(site: string, maxDepth: number | null, dryRun: boolean): Promise<ReplaceResult> {
  const token = await graphToken();
  if (!token) return { ok: false, error: 'Microsoft Graph is not connected', dryRun, actions: [], granted: 0, removed: 0, skipped: 0 };
  const found = await findSiteGroupGrants(site, maxDepth);
  if (!found.ok) return { ok: false, error: found.error, dryRun, actions: [], granted: 0, removed: 0, skipped: 0 };

  // Modern SG-SP groups: token -> {id, name}
  const gj = await gget(`https://graph.microsoft.com/v1.0/groups?$filter=${encodeURIComponent("startswith(displayName,'SG-SP')")}&$select=id,displayName&$top=200`, token);
  const modern = new Map<string, { id: string; name: string }>();
  for (const g of (gj.value || [])) {
    const tok = String(g.displayName || '').replace(/^sg-?sp-?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (tok) modern.set(tok, { id: g.id, name: g.displayName });
  }
  const matchModern = (tok: string): { id: string; name: string } | null => {
    if (modern.has(tok)) return modern.get(tok)!;
    let best: { id: string; name: string } | null = null; let bl = 0;
    for (const [k, v] of modern) { if ((tok.startsWith(k) || k.startsWith(tok)) && k.length > bl) { best = v; bl = k.length; } }
    return best;
  };

  const out: ReplaceResult = { ok: true, dryRun, actions: [], granted: 0, removed: 0, skipped: 0 };
  for (const g of found.grants) {
    const tok = modernToken(g.groupName);
    const m = matchModern(tok);
    // The /invite API accepts only read/write. An old "owner" (full control) grant becomes write (edit);
    // full control on a folder for a group is rare and can be re-set by hand if actually needed.
    const role = /restrictedview|read/i.test(g.roles) && !/write|owner/i.test(g.roles) ? 'read' : 'write';
    const act: ReplaceResult['actions'][number] = { path: g.path, item: g.item, oldGroup: g.groupName, modern: m ? m.name : null, roles: g.roles };
    if (!m) { act.note = `no SG-SP match for "${g.groupName}"`; out.skipped++; out.actions.push(act); continue; }
    if (dryRun) { out.actions.push(act); continue; }
    // eslint-disable-next-line no-await-in-loop
    const gr = await grantGroupToItem(g.driveId, g.itemId, m.id, token, role);
    act.granted = gr.ok;
    if (gr.ok) {
      out.granted++;
      // eslint-disable-next-line no-await-in-loop
      const rm = await removeSiteGroupGrant(g.driveId, g.itemId, g.permId);
      act.removed = rm.ok; if (rm.ok) out.removed++; else act.note = `grant ok, remove failed: ${rm.error}`;
    } else { act.note = `grant failed: ${gr.error}`; out.skipped++; }
    out.actions.push(act);
  }
  return out;
}

/** Remove one site-group permission from a folder. */
export async function removeSiteGroupGrant(driveId: string, itemId: string, permId: string): Promise<{ ok: boolean; error?: string }> {
  const token = await graphToken();
  if (!token) return { ok: false, error: 'Microsoft Graph is not connected' };
  const res = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/permissions/${permId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 160)}` };
  return { ok: true };
}
