import { graphToken } from './licenseSources';
import { buildEmployeeIndex, matchAdToEmployee } from './adAudit';

/**
 * Direct-share audit for one SharePoint site: files and folders shared straight to a person or via a
 * sharing link, bypassing the SG-SP groups. Uses Microsoft Graph (Sites.ReadWrite.All).
 *
 * Efficiency: a drive item only carries a `shared` facet once it has been shared, so we enumerate the
 * library cheaply and pull the (expensive) permission list ONLY for shared items. We then keep the
 * permissions that are NOT inherited (granted on the item itself) and that go to a user or a link,
 * and match each user to the BambooHR roster so disabled / non-employee shares stand out.
 */

const norm = (v: string | null | undefined): string => (v || '').trim().toLowerCase();

interface WalkCaps { maxFolders: number; maxPermChecks: number }

async function gget(url: string, token: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const wait = Math.min(5, parseInt(res.headers.get('retry-after') || '2', 10)) * 1000;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`graph ${res.status}: ${(await res.text()).slice(0, 180)}`);
    return res.json();
  }
  throw new Error('graph throttled (429) after retries');
}

/** Resolve a site URL like https://host/sites/Name to a Graph site id. */
async function resolveSiteId(siteUrl: string, token: string): Promise<string> {
  const u = new URL(siteUrl);
  const host = u.host;
  const path = u.pathname.replace(/\/+$/, ''); // /sites/Shared
  const j = await gget(`https://graph.microsoft.com/v1.0/sites/${host}:${path}?$select=id,displayName,webUrl`, token);
  return j.id;
}

export interface DirectShare {
  path: string;             // folder path of the item
  item: string;             // item name
  itemType: 'file' | 'folder';
  webUrl: string | null;
  grantType: 'user' | 'link';
  grantedTo: string | null; // display name / email of the user, or the link scope
  email: string | null;
  roles: string;            // read | write | owner
  linkScope: string | null; // anonymous | organization | users (for links)
  matched: boolean;         // grantee is a current employee
  status: string | null;    // employment status when matched
  enabled: boolean | null;  // account enabled (from roster; links are null)
  flag: string | null;      // 'Disabled', 'Not in BambooHR', 'Anonymous link', etc.
}

export interface DirectShareReport {
  ok: true;
  site: string;
  siteId: string;
  generatedAt: string;
  coverage: { drives: number; foldersScanned: number; itemsSeen: number; sharedItems: number; capped: boolean };
  summary: { shares: number; userShares: number; linkShares: number; disabled: number; nonEmployee: number; anonymousLinks: number };
  shares: DirectShare[];
}

export async function spDirectShares(
  siteUrl: string,
  caps: WalkCaps = { maxFolders: 600, maxPermChecks: 1500 },
  generatedAt = new Date().toISOString(),
): Promise<{ ok: false; error: string } | DirectShareReport> {
  const token = await graphToken();
  if (!token) return { ok: false, error: 'Microsoft Graph is not connected' };
  let siteId: string;
  try { siteId = await resolveSiteId(siteUrl, token); } catch (e) { return { ok: false, error: `could not resolve site: ${(e as Error).message}` }; }

  const idx = buildEmployeeIndex();
  const drives = await gget(`https://graph.microsoft.com/v1.0/sites/${siteId}/drives?$select=id,name`, token);
  const driveList: { id: string; name: string }[] = (drives.value || []).map((d: any) => ({ id: d.id, name: d.name }));

  const shares: DirectShare[] = [];
  const cov = { drives: driveList.length, foldersScanned: 0, itemsSeen: 0, sharedItems: 0, capped: false };

  const SELECT = '$select=id,name,webUrl,folder,file,shared,parentReference&$top=200';

  async function permsFor(driveId: string, itemId: string, path: string, name: string, itemType: 'file' | 'folder', webUrl: string | null): Promise<void> {
    let purl: string | null = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/permissions?$top=50`;
    while (purl) {
      const cur: string = purl;
      // eslint-disable-next-line no-await-in-loop
      const pj: any = await gget(cur, token);
      for (const p of pj.value || []) {
        if (p.inheritedFrom) continue; // inherited = from the site/library, not a direct share
        const roles = Array.isArray(p.roles) ? p.roles.join('/') : '';
        if (p.link) {
          const scope = p.link.scope || 'users';
          shares.push({ path, item: name, itemType, webUrl, grantType: 'link', grantedTo: `${scope} link`, email: null, roles, linkScope: scope, matched: false, status: null, enabled: null, flag: scope === 'anonymous' ? 'Anonymous link' : (scope === 'organization' ? 'Org-wide link' : 'Sharing link') });
          continue;
        }
        // direct principal grant(s): grantedToV2 (single) and grantedToIdentitiesV2 (multi)
        const principals = [p.grantedToV2, ...(p.grantedToIdentitiesV2 || [])].filter(Boolean);
        for (const gp of principals) {
          const user = gp.user || gp.siteUser;
          if (!user) continue; // group grants handled by the group audit; skip
          const email = user.email || user.userPrincipalName || (gp.siteUser && gp.siteUser.email) || null;
          const emp = matchAdToEmployee({ upn: email, email }, idx);
          const matched = !!emp;
          let flag: string | null = null;
          if (!matched) flag = 'Not in BambooHR';
          else if (emp && ['terminated', 'prehire', 'inactive'].includes(norm(emp.employment_status))) flag = `Not active (${emp.employment_status})`;
          shares.push({ path, item: name, itemType, webUrl, grantType: 'user', grantedTo: user.displayName || email, email, roles, linkScope: null, matched, status: emp ? emp.employment_status : null, enabled: null, flag });
        }
      }
      purl = pj['@odata.nextLink'] || null;
    }
  }

  // BFS the folder tree per drive, only checking permissions on items that were shared.
  for (const drive of driveList) {
    const queue: { id: string; path: string }[] = [{ id: 'root', path: `/${drive.name}` }];
    while (queue.length) {
      if (cov.foldersScanned >= caps.maxFolders || cov.sharedItems >= caps.maxPermChecks) { cov.capped = true; break; }
      const folder = queue.shift()!;
      cov.foldersScanned++;
      let url: string | null = `https://graph.microsoft.com/v1.0/drives/${drive.id}/items/${folder.id}/children?${SELECT}`;
      while (url) {
        const cur: string = url;
        // eslint-disable-next-line no-await-in-loop
        const j: any = await gget(cur, token);
        for (const it of j.value || []) {
          cov.itemsSeen++;
          const isFolder = !!it.folder;
          const childPath = `${folder.path}/${it.name}`;
          if (it.shared && cov.sharedItems < caps.maxPermChecks) {
            cov.sharedItems++;
            // eslint-disable-next-line no-await-in-loop
            try { await permsFor(drive.id, it.id, folder.path, it.name, isFolder ? 'folder' : 'file', it.webUrl || null); } catch { /* skip item on error */ }
          }
          if (isFolder && cov.foldersScanned + queue.length < caps.maxFolders) queue.push({ id: it.id, path: childPath });
        }
        url = j['@odata.nextLink'] || null;
      }
    }
  }

  const disabled = shares.filter((s) => s.flag && s.flag.startsWith('Not active')).length;
  const nonEmployee = shares.filter((s) => s.flag === 'Not in BambooHR').length;
  const anon = shares.filter((s) => s.flag === 'Anonymous link').length;
  const userShares = shares.filter((s) => s.grantType === 'user').length;
  const linkShares = shares.filter((s) => s.grantType === 'link').length;

  // Flagged first, then by path.
  shares.sort((a, b) => (Number(!!b.flag) - Number(!!a.flag)) || a.path.localeCompare(b.path) || a.item.localeCompare(b.item));

  return {
    ok: true,
    site: siteUrl,
    siteId,
    generatedAt,
    coverage: cov,
    summary: { shares: shares.length, userShares, linkShares, disabled, nonEmployee, anonymousLinks: anon },
    shares,
  };
}
