/**
 * Microsoft Graph: SharePoint access audit.
 *
 * Answers "who can see the Shared site and each of its folders" without PowerShell. Reuses the same
 * Entra app-registration credentials as the mail / license / group integrations
 * (MS_GRAPH_TENANT / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET). Reading site and folder
 * permissions requires the **Sites.Read.All** application permission granted to that app with admin
 * consent (group owners/members also use the GroupMember.Read.All already granted). Keyless- and
 * permissionless-safe: every export returns { ok, ... } instead of throwing, so a missing grant
 * degrades to a clear message rather than a crash.
 */
import { graphToken } from './licenseSources';

export function sharepointConfigured(): boolean {
  return !!(process.env.MS_GRAPH_TOKEN || (process.env.MS_GRAPH_TENANT && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET));
}

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Split a SharePoint site URL into the Graph { hostname, path } addressing pair. */
export function parseSiteUrl(url: string): { hostname: string; path: string } | null {
  try {
    const u = new URL(url.trim());
    const path = u.pathname.replace(/\/+$/, ''); // drop trailing slash: /sites/Shared
    if (!u.hostname) return null;
    return { hostname: u.hostname, path };
  } catch {
    return null;
  }
}

async function gget(token: string, url: string): Promise<{ ok: boolean; status: number; json: any; text?: string }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, json: null, text };
  }
  return { ok: true, status: res.status, json: await res.json().catch(() => ({})) };
}

/** Follow @odata.nextLink and return the concatenated `value` arrays (bounded, so a huge library
 *  never runs away). */
async function gcollect(token: string, url: string, cap = 500): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = url;
  let guard = 0;
  while (next && out.length < cap && guard < 20) {
    const r: { ok: boolean; json: any } = await gget(token, next);
    if (!r.ok) break;
    const val = (r.json && r.json.value) || [];
    out.push(...val);
    next = (r.json && r.json['@odata.nextLink']) || null;
    guard++;
  }
  return out.slice(0, cap);
}

/** Normalise one Graph permission object into a flat "who + what" row. */
function normalizePermission(p: any): { principal: string; type: string; roles: string[]; kind: string; inherited: boolean; inheritedFrom: string | null } {
  const roles: string[] = Array.isArray(p.roles) ? p.roles : [];
  const inheritedFrom = p.inheritedFrom && (p.inheritedFrom.path || p.inheritedFrom.name) ? (p.inheritedFrom.path || p.inheritedFrom.name) : null;
  // Sharing link permission
  if (p.link) {
    const scope = p.link.scope ? `${p.link.scope} link` : 'sharing link';
    return { principal: p.link.webUrl ? `${scope}` : scope, type: 'link', roles: roles.length ? roles : [p.link.type || 'view'], kind: 'link', inherited: !!inheritedFrom, inheritedFrom };
  }
  // Direct grant (grantedToV2 for a single principal, grantedToIdentitiesV2 for a set)
  const grantees: any[] = [];
  if (p.grantedToV2) grantees.push(p.grantedToV2);
  if (Array.isArray(p.grantedToIdentitiesV2)) grantees.push(...p.grantedToIdentitiesV2);
  if (!grantees.length && p.grantedTo) grantees.push(p.grantedTo); // legacy fallback
  const names = grantees.map((g) => {
    const who = g.user || g.group || g.siteGroup || g.application || g.device || {};
    const label = who.displayName || who.email || who.loginName || who.id || 'Unknown';
    const kind = g.user ? 'user' : g.group ? 'group' : g.siteGroup ? 'SharePoint group' : g.application ? 'app' : 'principal';
    return `${label} (${kind})`;
  });
  return {
    principal: names.join(', ') || 'Unknown principal',
    type: grantees.length && grantees[0].siteGroup ? 'SharePoint group' : grantees.length && grantees[0].group ? 'group' : 'user',
    roles: roles.length ? roles : ['read'],
    kind: 'grant',
    inherited: !!inheritedFrom,
    inheritedFrom,
  };
}

export interface FolderAccess {
  name: string;
  webUrl: string | null;
  unique: boolean; // true when the folder breaks inheritance (has at least one non-inherited grant)
  access: ReturnType<typeof normalizePermission>[];
  note?: string;
}
export interface SiteAudit {
  ok: boolean;
  error?: string;
  needsPermission?: boolean;
  site?: { id: string; name: string; webUrl: string; created: string | null };
  siteAccess?: ReturnType<typeof normalizePermission>[];
  library?: string;
  folders?: FolderAccess[];
  truncated?: boolean;
}

/**
 * Audit a SharePoint site: its site-wide sharing, plus every top-level folder in the default
 * document library with who can access it (and whether that access is unique to the folder or
 * inherited from the site). `maxFolders` bounds the folder scan so a big library stays responsive.
 */
export async function auditSharedSite(url: string, maxFolders = 60): Promise<SiteAudit> {
  if (!sharepointConfigured()) return { ok: false, error: 'Microsoft Graph is not connected' };
  const parsed = parseSiteUrl(url);
  if (!parsed) return { ok: false, error: `not a valid SharePoint site URL: ${url}` };
  const token = await graphToken();
  if (!token) return { ok: false, error: 'could not acquire a Graph token' };

  // 1) Resolve the site.
  const siteRes = await gget(token, `${GRAPH}/sites/${parsed.hostname}:${parsed.path}?$select=id,displayName,name,webUrl,createdDateTime`);
  if (!siteRes.ok) {
    const needsPermission = siteRes.status === 401 || siteRes.status === 403;
    return { ok: false, needsPermission, error: needsPermission ? 'Graph returned Access Denied. Add the Sites.Read.All application permission to the app registration and grant admin consent.' : `could not resolve site (${siteRes.status}): ${(siteRes.text || '').slice(0, 300)}` };
  }
  const s = siteRes.json;
  const site = { id: s.id as string, name: (s.displayName || s.name || parsed.path) as string, webUrl: s.webUrl as string, created: s.createdDateTime || null };

  // 2) Site-wide access: permissions on the default drive's root item.
  let siteAccess: ReturnType<typeof normalizePermission>[] = [];
  let library = 'Documents';
  const driveRes = await gget(token, `${GRAPH}/sites/${site.id}/drive?$select=id,name`);
  const driveId: string | null = driveRes.ok ? driveRes.json.id : null;
  if (driveRes.ok && driveRes.json.name) library = driveRes.json.name;
  if (driveId) {
    const rootPerms = await gcollect(token, `${GRAPH}/drives/${driveId}/root/permissions`);
    siteAccess = rootPerms.map(normalizePermission);
  }

  // 3) Top-level folders + their access.
  const folders: FolderAccess[] = [];
  let truncated = false;
  if (driveId) {
    const children = await gcollect(token, `${GRAPH}/drives/${driveId}/root/children?$select=id,name,folder,webUrl`, maxFolders + 1);
    const onlyFolders = children.filter((c) => c.folder);
    if (onlyFolders.length > maxFolders) truncated = true;
    for (const f of onlyFolders.slice(0, maxFolders)) {
      const perms = await gcollect(token, `${GRAPH}/drives/${driveId}/items/${f.id}/permissions`);
      const access = perms.map(normalizePermission);
      const unique = access.some((a) => !a.inherited);
      folders.push({ name: f.name, webUrl: f.webUrl || null, unique, access });
    }
  }

  return { ok: true, site, siteAccess, library, folders, truncated };
}
