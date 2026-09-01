/**
 * Paid-software license tracking. Many of the tools the company pays for per person (Adobe, Bluebeam,
 * HydraCAD, ...) have no API, so the source of truth is the vendor's user export. This imports such a
 * CSV, matches each row to an employee (email first, then a suffix/compound-surname-tolerant name),
 * and records who holds each app's license. Re-importing an app replaces its membership, so removing
 * a user from the vendor and re-uploading drops them here too.
 */
import { getDb } from '../db/index';
import { audit, nameKeyVariants, empDisplayNameOf } from '../people/service';

export interface SoftwareApp { id: number; name: string; vendor: string | null; has_api: number; seats_paid: number | null; cost_per_seat: number | null; }

const SEED_APPS: { name: string; vendor: string; has_api?: boolean }[] = [
  { name: 'Adobe Acrobat', vendor: 'Adobe', has_api: true },
  { name: 'Bluebeam Revu', vendor: 'Bluebeam' },
  { name: 'HydraCAD', vendor: 'Hydratec' },
  { name: 'AutoCAD', vendor: 'Autodesk', has_api: true },
  { name: 'ServiceTrade', vendor: 'ServiceTrade', has_api: true },
];

export function seedSoftwareApps(): void {
  const ins = getDb().prepare(`INSERT OR IGNORE INTO software_apps (name, vendor, has_api) VALUES (?, ?, ?)`);
  const tx = getDb().transaction(() => { for (const a of SEED_APPS) ins.run(a.name, a.vendor, a.has_api ? 1 : 0); });
  tx();
}

export function listSoftwareApps(): (SoftwareApp & { licensed: number })[] {
  const db = getDb();
  return (db.prepare(`SELECT * FROM software_apps WHERE active = 1 ORDER BY name`).all() as SoftwareApp[]).map((a) => ({
    ...a,
    licensed: (db.prepare(`SELECT COUNT(*) c FROM employee_software WHERE app_id = ? AND status = 'active'`).get(a.id) as any).c,
  }));
}

export function addSoftwareApp(input: { name: string; vendor?: string; has_api?: boolean; seats_paid?: number; cost_per_seat?: number }): SoftwareApp | null {
  const name = String(input.name || '').trim();
  if (!name) return null;
  const db = getDb();
  const info = db.prepare(`INSERT OR IGNORE INTO software_apps (name, vendor, has_api, seats_paid, cost_per_seat) VALUES (?, ?, ?, ?, ?)`)
    .run(name, input.vendor || null, input.has_api ? 1 : 0, input.seats_paid ?? null, input.cost_per_seat ?? null);
  const id = Number(info.lastInsertRowid) || (db.prepare(`SELECT id FROM software_apps WHERE name = ?`).get(name) as any)?.id;
  return db.prepare(`SELECT * FROM software_apps WHERE id = ?`).get(id) as SoftwareApp;
}

/* ─────────────────────────── CSV parsing + employee matching ─────────────────────────── */

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const headers = parseLine(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

const EMAIL_ALIASES = ['email', 'e-mail', 'mail', 'email address', 'user email', 'upn', 'user principal name', 'username', 'user name', 'login', 'account', 'user'];
const NAME_ALIASES = ['name', 'full name', 'display name', 'user', 'user name', 'first and last name', 'member'];
function findCol(headers: string[], aliases: string[]): number {
  for (const a of aliases) { const i = headers.indexOf(a); if (i >= 0) return i; }
  // loose contains-match
  for (let i = 0; i < headers.length; i++) if (aliases.some((a) => headers[i].includes(a))) return i;
  return -1;
}

const localPart = (s: string) => String(s || '').split('@')[0].trim().toLowerCase();

interface EmpMatch { id: number; name: string }
function buildIndex(): { byEmail: Map<string, number>; byName: Map<string, number | null>; byId: Map<number, EmpMatch> } {
  const emps = getDb().prepare(`SELECT id, legal_first_name, legal_last_name, preferred_name, entra_display_name, work_email, personal_email, upn FROM employees`).all() as any[];
  const byEmail = new Map<string, number>();
  const byName = new Map<string, number | null>();
  const byId = new Map<number, EmpMatch>();
  const putName = (k: string, id: number) => { if (!k) return; byName.set(k, byName.has(k) && byName.get(k) !== id ? null : id); };
  for (const e of emps) {
    byId.set(e.id, { id: e.id, name: empDisplayNameOf(e) });
    for (const em of [e.work_email, e.personal_email, e.upn]) if (em) { byEmail.set(String(em).toLowerCase(), e.id); byEmail.set(localPart(em), e.id); }
    for (const k of nameKeyVariants({ first: e.legal_first_name, last: e.legal_last_name, preferred: e.preferred_name, display: e.entra_display_name })) putName(k, e.id);
  }
  return { byEmail, byName, byId };
}

export interface SoftwareImportResult {
  ok: boolean; error?: string; committed: boolean; app: string;
  total: number; matched: number; unmatched: number; removed: number;
  recognized: string[]; rows: { value: string; matched_to: string | null }[];
}

export function importSoftwareCsv(appId: number, csv: string, commit: boolean): SoftwareImportResult {
  const db = getDb();
  const app = db.prepare(`SELECT * FROM software_apps WHERE id = ?`).get(appId) as SoftwareApp | undefined;
  if (!app) return { ok: false, error: 'unknown_app', committed: false, app: '', total: 0, matched: 0, unmatched: 0, removed: 0, recognized: [], rows: [] };
  const { headers, rows } = parseCsv(csv);
  if (!rows.length) return { ok: false, error: 'No data rows found in the file.', committed: false, app: app.name, total: 0, matched: 0, unmatched: 0, removed: 0, recognized: [], rows: [] };
  const emailCol = findCol(headers, EMAIL_ALIASES);
  const nameCol = findCol(headers, NAME_ALIASES);
  if (emailCol < 0 && nameCol < 0) return { ok: false, error: 'Could not find an email or name column. Check the header row.', committed: false, app: app.name, total: rows.length, matched: 0, unmatched: 0, removed: 0, recognized: [], rows: [] };
  const recognized = [emailCol >= 0 ? 'email' : '', nameCol >= 0 ? 'name' : ''].filter(Boolean);

  const idx = buildIndex();
  const seen = new Set<number>();
  const preview: { value: string; matched_to: string | null }[] = [];
  let matched = 0, unmatched = 0;
  for (const r of rows) {
    const email = emailCol >= 0 ? (r[emailCol] || '') : '';
    const name = nameCol >= 0 ? (r[nameCol] || '') : '';
    let empId: number | undefined;
    if (email) { empId = idx.byEmail.get(email.toLowerCase()) ?? idx.byEmail.get(localPart(email)); }
    if (empId == null && name) { for (const k of nameKeyVariants({ display: name })) { const hit = idx.byName.get(k); if (hit) { empId = hit; break; } } }
    if (empId != null) { matched++; seen.add(empId); } else unmatched++;
    preview.push({ value: email || name || '(blank)', matched_to: empId != null ? idx.byId.get(empId)!.name : null });
  }

  let removed = 0;
  if (commit) {
    const now = new Date().toISOString();
    const up = db.prepare(`INSERT INTO employee_software (employee_id, app_id, status, source, external_ref, assigned_at) VALUES (?, ?, 'active', 'csv', ?, ?)
      ON CONFLICT(employee_id, app_id) DO UPDATE SET status='active', source='csv', assigned_at=COALESCE(employee_software.assigned_at, excluded.assigned_at), removed_at=NULL`);
    // People present in a prior import but absent now are marked removed (the vendor no longer lists them).
    const existing = db.prepare(`SELECT employee_id FROM employee_software WHERE app_id = ? AND status = 'active'`).all(appId) as { employee_id: number }[];
    const tx = db.transaction(() => {
      for (const empId of seen) up.run(empId, appId, null, now);
      for (const e of existing) if (!seen.has(e.employee_id)) { db.prepare(`UPDATE employee_software SET status='removed', removed_at=? WHERE app_id=? AND employee_id=?`).run(now, appId, e.employee_id); removed++; }
    });
    tx();
    audit('software_imported', `${app.name}: ${matched} licensed, ${removed} removed`, {});
  }

  return { ok: true, committed: commit, app: app.name, total: rows.length, matched, unmatched, removed, recognized, rows: preview.slice(0, 400) };
}

/** Company view: each app with who holds it. */
export function softwareOverview(): { apps: (SoftwareApp & { licensed: number })[] } {
  return { apps: listSoftwareApps() };
}

/** One person's software licenses (for their profile). */
export function employeeSoftware(employee_id: number): any[] {
  return getDb().prepare(
    `SELECT es.id, es.status, es.source, es.external_ref, es.assigned_at, a.name, a.vendor
       FROM employee_software es JOIN software_apps a ON a.id = es.app_id
      WHERE es.employee_id = ? AND es.status = 'active' ORDER BY a.name`
  ).all(employee_id);
}
