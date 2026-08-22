import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';

/**
 * On-prem AD audit (P1: read-only).
 *
 * The DC agent posts a full AD snapshot (ingestInventory). The OS mirrors it, then compares it
 * against the employee record, which is authoritative for identity (Bamboo/OS), to surface drift:
 * terminated accounts still enabled or still in groups, missing title / mobile, and enabled accounts
 * with no matching employee. P1 writes nothing back to AD; it only reports what a later phase would fix.
 */

const K_LAST_SYNC = 'ad_last_sync';

export interface AdUserIn {
  objectGuid: string;
  sam?: string;
  upn?: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  title?: string;
  mobile?: string;
  department?: string;
  office?: string;
  email?: string;
  enabled?: boolean;
  ou?: string;
  dn?: string;
  whenCreated?: string;
  lastLogon?: string;
  groups?: { name: string; dn?: string }[];
}

const s = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t : null;
};

/** Replace the whole AD mirror with a fresh snapshot, in one transaction. */
export function ingestInventory(users: AdUserIn[], collectedAt?: string): { stored: number; groups: number } {
  const db = getDb();
  const insUser = db.prepare(
    `INSERT OR REPLACE INTO ad_users
      (object_guid, sam, upn, display_name, given_name, surname, title, mobile, department, office,
       email, enabled, ou, dn, when_created, last_logon, synced_at)
     VALUES (@object_guid,@sam,@upn,@display_name,@given_name,@surname,@title,@mobile,@department,@office,
       @email,@enabled,@ou,@dn,@when_created,@last_logon,datetime('now'))`
  );
  const insGroup = db.prepare(`INSERT INTO ad_user_groups (object_guid, sam, group_name, group_dn) VALUES (?,?,?,?)`);
  let groupCount = 0;
  const run = db.transaction((rows: AdUserIn[]) => {
    db.prepare(`DELETE FROM ad_users`).run();
    db.prepare(`DELETE FROM ad_user_groups`).run();
    for (const u of rows) {
      if (!u || !u.objectGuid) continue;
      insUser.run({
        object_guid: String(u.objectGuid),
        sam: s(u.sam),
        upn: s(u.upn),
        display_name: s(u.displayName),
        given_name: s(u.givenName),
        surname: s(u.surname),
        title: s(u.title),
        mobile: s(u.mobile),
        department: s(u.department),
        office: s(u.office),
        email: s(u.email),
        enabled: u.enabled === false ? 0 : 1,
        ou: s(u.ou),
        dn: s(u.dn),
        when_created: s(u.whenCreated),
        last_logon: s(u.lastLogon),
      });
      for (const g of u.groups || []) {
        const name = s(g && g.name);
        if (!name) continue;
        insGroup.run(String(u.objectGuid), s(u.sam), name, s(g.dn));
        groupCount++;
      }
    }
  });
  run(users);
  const stored = users.filter((u) => u && u.objectGuid).length;
  setState(K_LAST_SYNC, JSON.stringify({ at: new Date().toISOString(), collectedAt: collectedAt || null, users: stored, groups: groupCount }));
  return { stored, groups: groupCount };
}

export function lastSync(): { at: string; collectedAt: string | null; users: number; groups: number } | null {
  const raw = getState(K_LAST_SYNC);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/* ─────────────────────────── OU structure ─────────────────────────── */

export interface OuNode { ou: string; label: string; users: number; enabled: number; children: OuNode[] }

/** Build a nested OU tree with per-container user counts from the mirrored users. */
export function ouTree(): OuNode[] {
  const db = getDb();
  const rows = db.prepare(`SELECT ou, enabled FROM ad_users WHERE ou IS NOT NULL`).all() as { ou: string; enabled: number }[];
  const roots: OuNode[] = [];
  const index = new Map<string, OuNode>();

  // Split an OU DN into its ordered path from the top: DC parts dropped, OU parts reversed so the
  // top-level container is first. "OU=Sales,OU=Users,DC=x,DC=y" -> ["Users","Sales"].
  const pathOf = (dn: string): string[] => {
    const parts = dn.split(',').map((p) => p.trim());
    const ous = parts.filter((p) => /^OU=/i.test(p)).map((p) => p.slice(3));
    return ous.reverse();
  };

  for (const r of rows) {
    const segs = pathOf(r.ou);
    if (!segs.length) continue;
    let level = roots;
    let keyAcc = '';
    for (const seg of segs) {
      keyAcc = keyAcc ? `${keyAcc}/${seg}` : seg;
      let node = index.get(keyAcc);
      if (!node) {
        node = { ou: keyAcc, label: seg, users: 0, enabled: 0, children: [] };
        index.set(keyAcc, node);
        level.push(node);
      }
      node.users += 1;
      if (r.enabled) node.enabled += 1;
      level = node.children;
    }
  }
  const sort = (nodes: OuNode[]) => { nodes.sort((a, b) => b.users - a.users || a.label.localeCompare(b.label)); nodes.forEach((n) => sort(n.children)); };
  sort(roots);
  return roots;
}

/* ─────────────────────────── drift ─────────────────────────── */

export type DriftCode =
  | 'terminated_enabled'
  | 'terminated_in_groups'
  | 'missing_title'
  | 'missing_mobile'
  | 'title_mismatch'
  | 'orphan_enabled';

export interface DriftFinding {
  code: DriftCode;
  severity: 'critical' | 'high' | 'medium' | 'low';
  sam: string | null;
  upn: string | null;
  name: string | null;
  ou: string | null;
  current: string | null;
  expected: string | null;
  detail: string;
}

export interface EmpRow {
  id: number;
  legal_first_name: string | null;
  legal_last_name: string | null;
  work_email: string | null;
  upn: string | null;
  ad_username: string | null;
  employment_status: string | null;
  job_position: string | null;
  public_job_title: string | null;
  personal_phone: string | null;
  manager: string | null;
  office: string | null;
}

const norm = (v: string | null | undefined): string => (v || '').trim().toLowerCase();
const digits = (v: string | null | undefined): string => (v || '').replace(/\D/g, '');

export interface EmployeeIndex { byUpn: Map<string, EmpRow>; bySam: Map<string, EmpRow>; all: EmpRow[] }

/** Load employees and index them by the identifiers an AD account can carry (UPN, work email, sAM). */
export function buildEmployeeIndex(): EmployeeIndex {
  const db = getDb();
  const all = db.prepare(
    `SELECT id, legal_first_name, legal_last_name, work_email, upn, ad_username, employment_status,
            job_position, public_job_title, personal_phone, manager, office FROM employees`
  ).all() as EmpRow[];
  const byUpn = new Map<string, EmpRow>();
  const bySam = new Map<string, EmpRow>();
  for (const e of all) {
    if (e.upn) byUpn.set(norm(e.upn), e);
    if (e.work_email) byUpn.set(norm(e.work_email), e);
    if (e.ad_username) bySam.set(norm(e.ad_username), e);
  }
  return { byUpn, bySam, all };
}

/** Match one AD user row (or {upn,email,sam}) to an employee via the index. */
export function matchAdToEmployee(a: { upn?: string | null; email?: string | null; sam?: string | null }, idx: EmployeeIndex): EmpRow | undefined {
  return (a.upn && idx.byUpn.get(norm(a.upn))) || (a.email && idx.byUpn.get(norm(a.email))) || (a.sam && idx.bySam.get(norm(a.sam))) || undefined;
}

/** Compare the AD mirror against the employee record and return every drift finding. */
export function computeDrift(): { findings: DriftFinding[]; counts: Record<string, number>; matched: number; unmatched: number } {
  const db = getDb();
  const adUsers = db.prepare(`SELECT * FROM ad_users`).all() as any[];
  const groupCounts = db.prepare(`SELECT object_guid, COUNT(*) AS c FROM ad_user_groups GROUP BY object_guid`).all() as { object_guid: string; c: number }[];
  const groupsByGuid = new Map(groupCounts.map((g) => [g.object_guid, g.c]));

  const idx = buildEmployeeIndex();
  const matchEmp = (a: any): EmpRow | undefined => matchAdToEmployee(a, idx);

  const empTitle = (e: EmpRow): string | null => e.public_job_title || e.job_position || null;
  const findings: DriftFinding[] = [];
  let matched = 0, unmatched = 0;

  for (const a of adUsers) {
    const e = matchEmp(a);
    const base = { sam: a.sam || null, upn: a.upn || null, name: a.display_name || null, ou: a.ou || null };
    if (!e) {
      unmatched++;
      if (a.enabled) findings.push({ ...base, code: 'orphan_enabled', severity: 'medium', current: 'enabled, no employee match', expected: null, detail: 'Enabled AD account with no matching employee. Could be a service/shared account or a stale one to review.' });
      continue;
    }
    matched++;
    const terminated = norm(e.employment_status) === 'terminated';
    if (terminated && a.enabled) {
      findings.push({ ...base, code: 'terminated_enabled', severity: 'critical', current: 'enabled', expected: 'disabled', detail: 'Employee is terminated but the AD account is still enabled.' });
    }
    if (terminated && (groupsByGuid.get(a.object_guid) || 0) > 0) {
      const c = groupsByGuid.get(a.object_guid) || 0;
      findings.push({ ...base, code: 'terminated_in_groups', severity: 'high', current: `${c} group${c === 1 ? '' : 's'}`, expected: '0 groups', detail: `Terminated employee is still a member of ${c} security group${c === 1 ? '' : 's'}.` });
    }
    if (!terminated) {
      const wantTitle = empTitle(e);
      if (wantTitle && !a.title) {
        findings.push({ ...base, code: 'missing_title', severity: 'low', current: null, expected: wantTitle, detail: 'AD account has no job title; the employee record has one.' });
      } else if (wantTitle && a.title && norm(a.title) !== norm(wantTitle)) {
        findings.push({ ...base, code: 'title_mismatch', severity: 'low', current: a.title, expected: wantTitle, detail: 'AD job title does not match the employee record (Bamboo is authoritative).' });
      }
      if (e.personal_phone && !a.mobile) {
        findings.push({ ...base, code: 'missing_mobile', severity: 'low', current: null, expected: e.personal_phone, detail: 'AD account has no mobile number; the employee record has one.' });
      } else if (e.personal_phone && a.mobile && digits(a.mobile).slice(-10) !== digits(e.personal_phone).slice(-10)) {
        findings.push({ ...base, code: 'missing_mobile', severity: 'low', current: a.mobile, expected: e.personal_phone, detail: 'AD mobile number does not match the employee record.' });
      }
    }
  }

  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.code] = (counts[f.code] || 0) + 1;
  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((x, y) => sevRank[x.severity] - sevRank[y.severity]);
  return { findings, counts, matched, unmatched };
}

/** The full read-only audit payload the dashboard renders. */
export function auditReport() {
  const drift = computeDrift();
  const db = getDb();
  const adUserCount = (db.prepare(`SELECT COUNT(*) AS c FROM ad_users`).get() as { c: number }).c;
  const enabledCount = (db.prepare(`SELECT COUNT(*) AS c FROM ad_users WHERE enabled = 1`).get() as { c: number }).c;
  return {
    lastSync: lastSync(),
    adUserCount,
    enabledCount,
    matched: drift.matched,
    unmatched: drift.unmatched,
    counts: drift.counts,
    findings: drift.findings,
    ouTree: ouTree(),
  };
}
