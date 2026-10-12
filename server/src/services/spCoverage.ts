import { getState, setState } from '../db/schema';

/**
 * Which SharePoint access groups already include others.
 *
 * Read from the real folder permissions on the Shared site: for every top-level folder, which SG-SP
 * groups can open it (granted there or inherited from above). Group A "includes" group B when every
 * folder B opens, A opens too: picking B on top of A adds nothing. The onboarding form hides the
 * included groups once A is picked, and a request never creates a redundant "Add to group" task.
 *
 * Refreshed daily by the scheduler (and on demand). Stored as plain folder lists so the rule can be
 * re-derived without Graph; with no data yet nothing is hidden.
 */

const K = 'sp_group_coverage';
export const SHARED_SITE = (process.env.SP_SHARED_SITE || 'https://1stfp.sharepoint.com/sites/Shared/').trim();

export interface CoverageData { at: string; site: string; folders: Record<string, string[]>; names: Record<string, string> }

/** One key per group, whatever it is called: "SG-SP-Accounting", "ACCT", "Accounting" -> "accounting". */
const ALIAS: Record<string, string> = { acct: 'accounting', mgmt: 'management', servicessanantonio: 'sanantonio', services: 'sanantonio' };
export function groupKey(name: string | null | undefined): string {
  const k = String(name || '').replace(/^sg-?sp-?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return ALIAS[k] || k;
}

export function loadCoverage(): CoverageData | null {
  const raw = getState(K);
  if (!raw) return null;
  try { return JSON.parse(raw) as CoverageData; } catch { return null; }
}

/** Turn folder grants into { groupKey: [folder paths] }. Only real groups count (not single users). */
export function foldersByGroup(folders: { drive: string; folder: string; grants: { kind: string; name: string }[] }[]): { folders: Record<string, string[]>; names: Record<string, string> } {
  const out: Record<string, Set<string>> = {}, names: Record<string, string> = {};
  for (const f of folders) {
    const path = `${f.drive}/${f.folder}`;
    for (const g of f.grants) {
      if (g.kind === 'user') continue;
      const k = groupKey(g.name);
      if (!k) continue;
      (out[k] = out[k] || new Set()).add(path);
      names[k] = names[k] || g.name;
    }
  }
  const folderMap: Record<string, string[]> = {};
  for (const [k, s] of Object.entries(out)) folderMap[k] = [...s].sort();
  return { folders: folderMap, names };
}

/** For the given catalog group names: which other listed groups each one already includes. */
export function includesMap(catalogNames: string[], data: CoverageData | null = loadCoverage()): Record<string, string[]> {
  const res: Record<string, string[]> = {};
  if (!data) return res;
  for (const a of catalogNames) {
    const fa = new Set(data.folders[groupKey(a)] || []);
    if (!fa.size) continue;
    const inc = catalogNames.filter((b) => {
      if (b === a || groupKey(b) === groupKey(a)) return false;
      const fb = data.folders[groupKey(b)] || [];
      return fb.length > 0 && fb.every((p) => fa.has(p));
    });
    if (inc.length) res[a] = inc;
  }
  return res;
}

/** Drop groups another chosen group already includes (both included in each other: keep the first). */
export function dropIncluded(chosen: string[], data: CoverageData | null = loadCoverage()): string[] {
  const inc = includesMap(chosen, data);
  const drop = new Set<string>();
  for (const a of chosen) {
    if (drop.has(a)) continue;
    for (const b of inc[a] || []) drop.add(b);
  }
  return chosen.filter((n) => !drop.has(n));
}

/** Re-read the folder permissions from SharePoint and store them. */
export async function refreshCoverage(site = SHARED_SITE): Promise<{ ok: boolean; error?: string; groups?: number; folders?: number }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getTopFolderGrants } = require('./spSiteGroupCleanup') as typeof import('./spSiteGroupCleanup');
  const out = await getTopFolderGrants(site);
  if (!out.ok) return { ok: false, error: out.error };
  const { folders, names } = foldersByGroup(out.folders);
  setState(K, JSON.stringify({ at: new Date().toISOString(), site, folders, names } as CoverageData));
  return { ok: true, groups: Object.keys(folders).length, folders: out.folders.length };
}

/* ─────────── the report: what each group opens, and what it already includes ─────────── */
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const NICE: Record<string, string> = { McAllen: 'McAllen', ContractPayAppSOVLiens: 'Contract Pay Apps, SOV and Lien Waivers', '1AutoInsurance': 'Auto Insurance', OneStop: 'One Stop Code', Firecon: 'FireCon', Services: 'Services (San Antonio)', SanAntonio: 'San Antonio' };
const nice = (n: string) => { const s = n.replace(/^sg-?sp-?/i, ''); return NICE[s] || s.replace(/([a-z])([A-Z])/g, '$1 $2'); };

export function coverageReportHtml(data: CoverageData, catalogNames: string[]): string {
  const inc = includesMap(catalogNames, data);
  const rows = catalogNames
    .filter((n) => !/all\s*staff/i.test(n))
    .map((n) => {
      const f = data.folders[groupKey(n)] || [];
      return `<tr><td style="padding:8px 10px;border-bottom:1px solid #e8e8ed;font-weight:700;vertical-align:top">${esc(nice(n))}<div style="font-weight:400;font-size:11px;color:#86868b">${esc(n)}</div></td>`
        + `<td style="padding:8px 10px;border-bottom:1px solid #e8e8ed;font-size:13px;vertical-align:top">${f.length ? esc(f.map((p) => p.split('/').slice(1).join('/')).join(', ')) : '<span style="color:#a15c00">no top-level folder found for this group</span>'}</td>`
        + `<td style="padding:8px 10px;border-bottom:1px solid #e8e8ed;font-size:13px;vertical-align:top">${inc[n] ? esc(inc[n].map(nice).join(', ')) : '<span style="color:#86868b">nothing else</span>'}</td></tr>`;
    }).join('');
  return `<div style="font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;color:#1d1d1f;max-width:820px">
  <p style="font-size:20px;font-weight:800;margin:0 0 4px">SharePoint groups: what each one opens</p>
  <p style="font-size:13px;color:#6e6e73;margin:0 0 14px">From the folder permissions on ${esc(data.site)}, read ${esc(data.at.slice(0, 16).replace('T', ' '))} UTC. A group opens a folder when it is granted there or above it. "Already includes" means every folder that group opens, this one opens too, so the onboarding form hides it once this one is picked.</p>
  <table style="border-collapse:collapse;width:100%"><tr>
    <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #d2d2d7;font-size:11px;color:#6e6e73;text-transform:uppercase">Group</th>
    <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #d2d2d7;font-size:11px;color:#6e6e73;text-transform:uppercase">Opens these folders</th>
    <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #d2d2d7;font-size:11px;color:#6e6e73;text-transform:uppercase">Already includes</th></tr>${rows}</table>
</div>`;
}
