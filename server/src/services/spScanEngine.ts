import { getDb } from '../db/index';
import { graphToken } from './licenseSources';
import { buildEmployeeIndex, matchAdToEmployee, EmpRow } from './adAudit';

/**
 * Resumable, poll-driven SharePoint direct-share scan.
 *
 * A full walk of a heavily-shared site takes many minutes, so an in-memory background job is fragile:
 * any server restart (deploy, idle reclaim) loses it. Here the walk state lives in the sp_scans row
 * (the folder queue + the current folder's pagination cursor) and found shares stream into
 * sp_scan_shares. The client calls step() repeatedly; each step does a short, time-boxed batch and
 * saves state, so a restart just means the next step() resumes from the database. No step ever runs
 * long enough to time out, and "server restarted" can no longer fail a scan.
 */

const norm = (v: string | null | undefined): string => (v || '').trim().toLowerCase();
const STEP_MS = 11000;        // wall-clock budget per step()
const STEP_PERM_CAP = 120;    // also cap permission fetches per step, to bound Graph load

async function gget(url: string, token: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const wait = Math.min(5, parseInt(res.headers.get('retry-after') || '2', 10)) * 1000;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`graph ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }
  throw new Error('graph throttled (429) after retries');
}

interface WalkState {
  siteId: string;
  drives: { id: string; name: string }[];
  queue: { driveId: string; id: string; path: string; depth: number }[];
  current: { driveId: string; id: string; path: string; depth: number; nextLink: string | null } | null;
  cov: { foldersScanned: number; itemsSeen: number; sharedItems: number; siteGroupGrants: number };
  // How many folder levels below the drive root to descend. null = unlimited (whole tree). A drive
  // root is depth 0, its immediate subfolders are depth 1, and so on. Older scans have no maxDepth,
  // which reads as unlimited, so they keep their original behavior on resume.
  maxDepth?: number | null;
}

function parse<T>(s: string | null, fallback: T): T { if (!s) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } }

/** Create a scan row, resolve the site + its drives, and seed the folder queue. Returns the id. */
export async function startScan(site: string, maxDepth: number | null = null): Promise<{ id?: number; error?: string }> {
  const db = getDb();
  const token = await graphToken();
  if (!token) return { error: 'Microsoft Graph is not connected' };
  try {
    const u = new URL(site);
    const path = u.pathname.replace(/\/+$/, '');
    const s = await gget(`https://graph.microsoft.com/v1.0/sites/${u.host}:${path}?$select=id`, token);
    const dv = await gget(`https://graph.microsoft.com/v1.0/sites/${s.id}/drives?$select=id,name`, token);
    const drives = (dv.value || []).map((d: any) => ({ id: d.id, name: d.name }));
    const state: WalkState = {
      siteId: s.id, drives,
      queue: drives.map((d: { id: string; name: string }) => ({ driveId: d.id, id: 'root', path: `/${d.name}`, depth: 0 })),
      current: null,
      cov: { foldersScanned: 0, itemsSeen: 0, sharedItems: 0, siteGroupGrants: 0 },
      maxDepth: (typeof maxDepth === 'number' && maxDepth >= 0) ? maxDepth : null,
    };
    const info = db.prepare(`INSERT INTO sp_scans (site, status, state_json, progress_json) VALUES (?, 'running', ?, ?)`)
      .run(site, JSON.stringify(state), JSON.stringify(state.cov));
    return { id: Number(info.lastInsertRowid) };
  } catch (e) { return { error: (e as Error).message }; }
}

/** Advance one scan by a short, time-boxed batch. Safe to call repeatedly; resumes from saved state. */
export async function stepScan(id: number): Promise<{ ok: boolean; status: string; progress?: any; error?: string }> {
  const db = getDb();
  const row = db.prepare(`SELECT status, state_json FROM sp_scans WHERE id = ?`).get(id) as { status: string; state_json: string | null } | undefined;
  if (!row) return { ok: false, status: 'error', error: 'scan not found' };
  if (row.status !== 'running') return { ok: true, status: row.status };

  const token = await graphToken();
  if (!token) return { ok: false, status: 'running', error: 'Microsoft Graph is not connected' };
  const state = parse<WalkState | null>(row.state_json, null);
  if (!state) { db.prepare(`UPDATE sp_scans SET status='error', error='lost scan state' WHERE id=?`).run(id); return { ok: false, status: 'error', error: 'lost scan state' }; }

  // Employee match (rebuilt per step; cheap). Name fallback for staff without a work email.
  const idx = buildEmployeeIndex();
  const byName = new Map<string, EmpRow>();
  for (const e of idx.all) { const nm = norm([e.legal_first_name, e.legal_last_name].filter(Boolean).join(' ')); if (nm) byName.set(nm, e); }
  const matchPrincipal = (email: string | null, dn: string | null): EmpRow | undefined =>
    matchAdToEmployee({ upn: email, email }, idx) || (norm(dn) ? byName.get(norm(dn)) : undefined);
  // The on-prem AD mirror carries the enabled flag, so a grantee who is not in the HR roster can
  // still be recognised as a disabled (former) account instead of an unknown "verify".
  const adByKey = new Map<string, boolean>();
  const adByName = new Map<string, boolean>();
  try {
    const adRows = db.prepare(`SELECT email, upn, sam, display_name, enabled FROM ad_users`).all() as { email: string | null; upn: string | null; sam: string | null; display_name: string | null; enabled: number }[];
    for (const a of adRows) {
      const en = a.enabled !== 0;
      for (const k of [a.email, a.upn, a.sam]) { const nk = norm(k); if (nk && !adByKey.has(nk)) adByKey.set(nk, en); }
      const nm = norm(a.display_name); if (nm && !adByName.has(nm)) adByName.set(nm, en);
    }
  } catch { /* no AD mirror yet */ }
  /** true = matches a disabled AD account, false = enabled AD account, null = no AD match. */
  const adEnabledState = (email: string | null, dn: string | null): boolean | null => {
    const k = norm(email); if (k && adByKey.has(k)) return adByKey.get(k)!;
    const n = norm(dn); if (n && adByName.has(n)) return adByName.get(n)!;
    return null;
  };
  const isSiteGroup = (dn: string, email: string | null) =>
    /(owners|members|visitors)$/i.test(dn) || /^everyone/i.test(dn) || /company administrator/i.test(dn) || !email;

  const insertShare = db.prepare(`INSERT INTO sp_scan_shares (scan_id, data_json) VALUES (?, ?)`);
  const SELECT = '$select=id,name,webUrl,folder,file,shared&$top=200';
  const started = Date.now();
  let permThisStep = 0;

  try {
    while (Date.now() - started < STEP_MS && permThisStep < STEP_PERM_CAP) {
      if (!state.current) {
        const next = state.queue.shift();
        if (!next) break; // queue drained -> finished (handled below)
        state.current = { ...next, nextLink: null };
      }
      const cur = state.current;
      const url = cur.nextLink || `https://graph.microsoft.com/v1.0/drives/${cur.driveId}/items/${cur.id}/children?${SELECT}`;
      // eslint-disable-next-line no-await-in-loop
      const page: any = await gget(url, token);
      for (const it of page.value || []) {
        state.cov.itemsSeen++;
        const isFolder = !!it.folder;
        if (it.shared) {
          state.cov.sharedItems++;
          permThisStep++;
          // eslint-disable-next-line no-await-in-loop
          try {
            const pj: any = await gget(`https://graph.microsoft.com/v1.0/drives/${cur.driveId}/items/${it.id}/permissions?$top=50`, token);
            for (const p of pj.value || []) {
              if (p.inheritedFrom) continue;
              const roles = Array.isArray(p.roles) ? p.roles.join('/') : '';
              if (p.link) {
                const scope = p.link.scope || 'users';
                insertShare.run(id, JSON.stringify({ driveId: cur.driveId, itemId: it.id, permId: p.id, path: cur.path, item: it.name, itemType: isFolder ? 'folder' : 'file', grantType: 'link', grantedTo: `${scope} link`, email: null, roles, linkScope: scope, matched: false, status: null, flag: scope === 'anonymous' ? 'Anonymous link' : (scope === 'organization' ? 'Org-wide link' : 'Sharing link') }));
                continue;
              }
              const principals = [p.grantedToV2, ...(p.grantedToIdentitiesV2 || [])].filter(Boolean);
              for (const gp of principals) {
                const user = gp.user || gp.siteUser;
                if (!user) continue;
                const email = user.email || user.userPrincipalName || null;
                const dn = user.displayName || '';
                if (isSiteGroup(dn, email)) { state.cov.siteGroupGrants++; continue; }
                const emp = matchPrincipal(email, dn);
                const matched = !!emp;
                let flag: string | null = null;
                if (emp && ['terminated', 'prehire', 'inactive'].includes(norm(emp.employment_status))) flag = `Not active (${emp.employment_status})`;
                else if (!matched) {
                  // Not in the HR roster: distinguish a disabled former account from an unknown one.
                  const ad = adEnabledState(email, dn);
                  flag = ad === false ? 'Disabled account' : 'Not in BambooHR';
                }
                insertShare.run(id, JSON.stringify({ driveId: cur.driveId, itemId: it.id, permId: p.id, path: cur.path, item: it.name, itemType: isFolder ? 'folder' : 'file', grantType: 'user', grantedTo: dn || email, email, roles, linkScope: null, matched, status: emp ? emp.employment_status : null, flag }));
              }
            }
          } catch { /* skip item on permission error */ }
        }
        if (isFolder) {
          const childDepth = (cur.depth ?? 0) + 1;
          // Descend only within the depth cap; null/undefined maxDepth = unlimited (old behavior).
          if (state.maxDepth == null || childDepth <= state.maxDepth) {
            state.queue.push({ driveId: cur.driveId, id: it.id, path: `${cur.path}/${it.name}`, depth: childDepth });
          }
        }
      }
      cur.nextLink = page['@odata.nextLink'] || null;
      if (!cur.nextLink) { state.cov.foldersScanned++; state.current = null; }
    }
  } catch (e) {
    db.prepare(`UPDATE sp_scans SET state_json=?, progress_json=? WHERE id=?`).run(JSON.stringify(state), JSON.stringify(state.cov), id);
    return { ok: false, status: 'running', error: (e as Error).message }; // transient; client can retry the step
  }

  const finished = !state.current && state.queue.length === 0;
  if (finished) {
    const summary = summarize(id);
    db.prepare(`UPDATE sp_scans SET status='done', finished_at=datetime('now'), state_json=?, progress_json=?, result_json=? WHERE id=?`)
      .run(JSON.stringify(state), JSON.stringify(state.cov), JSON.stringify(summary), id);
    return { ok: true, status: 'done', progress: state.cov };
  }
  db.prepare(`UPDATE sp_scans SET state_json=?, progress_json=? WHERE id=?`).run(JSON.stringify(state), JSON.stringify(state.cov), id);
  return { ok: true, status: 'running', progress: state.cov };
}

function summarize(id: number): any {
  const db = getDb();
  const rows = db.prepare(`SELECT data_json FROM sp_scan_shares WHERE scan_id = ?`).all(id) as { data_json: string }[];
  const shares = rows.map((r) => parse<any>(r.data_json, null)).filter(Boolean);
  return {
    shares: shares.length,
    userShares: shares.filter((s) => s.grantType === 'user').length,
    linkShares: shares.filter((s) => s.grantType === 'link').length,
    disabled: shares.filter((s) => s.flag && String(s.flag).startsWith('Not active')).length,
    nonEmployee: shares.filter((s) => s.flag === 'Not in BambooHR').length,
    anonymousLinks: shares.filter((s) => s.flag === 'Anonymous link').length,
  };
}

/** Read a scan's state; when done, include the summary and all found shares. */
export function getScan(id: number): any {
  const db = getDb();
  const r = db.prepare(`SELECT id, site, status, started_at, finished_at, progress_json, result_json, error FROM sp_scans WHERE id = ?`).get(id) as any;
  if (!r) return null;
  const out: any = { id: r.id, site: r.site, status: r.status, started_at: r.started_at, finished_at: r.finished_at, progress: parse(r.progress_json, null), error: r.error };
  if (r.status === 'done') {
    out.summary = parse(r.result_json, null);
    const rows = db.prepare(`SELECT data_json FROM sp_scan_shares WHERE scan_id = ? ORDER BY id`).all(id) as { data_json: string }[];
    let shares = rows.map((x) => parse<any>(x.data_json, null)).filter(Boolean);
    shares.sort((a, b) => (Number(!!b.flag) - Number(!!a.flag)) || String(a.path).localeCompare(b.path) || String(a.item).localeCompare(b.item));
    out.shares = shares;
    out.coverage = { ...(out.progress || {}), capped: false };
  }
  return out;
}

/** Most recent completed scan for a site, to show on load. */
export function latestScan(site: string): any {
  const db = getDb();
  const r = db.prepare(`SELECT id FROM sp_scans WHERE site = ? AND status = 'done' ORDER BY id DESC LIMIT 1`).get(site) as { id: number } | undefined;
  return r ? getScan(r.id) : null;
}
