/**
 * RMM computer import: turn an exported spreadsheet of every machine in the RMM into real
 * employee_assets rows, matched to employees so each person's Assets tab shows their actual
 * computer(s). Tolerant of column names (works across NinjaOne, Datto, Atera, Syncro, ConnectWise,
 * Level, and a plain "save as CSV" from Excel) by matching headers against a set of aliases.
 *
 * Idempotent: a machine is keyed by its serial (or device name when there is no serial), so
 * re-importing an updated export updates rows in place instead of duplicating them. Preview first
 * (commit = false) shows exactly what would change before anything is written.
 */
import { getDb } from '../db/index';
import { audit } from '../people/service';

export interface ComputerRow {
  device_name: string;
  serial: string;
  model: string;
  user: string;
  email: string;
  os: string;
  last_seen: string;
}

/** Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, commas and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const s = text.replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignore; \n handles the break */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const HEADER_ALIASES: Record<keyof ComputerRow, string[]> = {
  device_name: ['device name', 'device', 'hostname', 'host name', 'computer name', 'computer', 'machine name', 'system name', 'name', 'display name', 'asset name'],
  serial: ['serial number', 'serial', 'serial no', 'service tag', 'serialnumber', 'bios serial number'],
  model: ['model', 'device model', 'hardware model', 'system model', 'product'],
  user: ['last user', 'last logged on user', 'last logged in user', 'primary user', 'assigned user', 'assigned to', 'user', 'logged on user', 'most recent user', 'last login user', 'owner'],
  email: ['user email', 'email', 'user principal name', 'upn', 'email address', 'primary user email', 'assigned user email'],
  os: ['os', 'operating system', 'os name', 'platform', 'os version'],
  last_seen: ['last seen', 'last online', 'last contact', 'last check-in', 'last checkin', 'last activity', 'last reboot', 'last boot', 'last connected'],
};

/** Map each ComputerRow field to the column index it lives in (or -1). Case/space-insensitive. */
export function mapHeaders(headerRow: string[]): Record<keyof ComputerRow, number> {
  const norm = (x: string) => x.trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
  const cols = headerRow.map(norm);
  const out = {} as Record<keyof ComputerRow, number>;
  (Object.keys(HEADER_ALIASES) as (keyof ComputerRow)[]).forEach((field) => {
    let idx = -1;
    for (const alias of HEADER_ALIASES[field]) {
      const at = cols.indexOf(alias);
      if (at >= 0) { idx = at; break; }
    }
    out[field] = idx;
  });
  return out;
}

export function rowsFromCsv(text: string): { rows: ComputerRow[]; mapping: Record<keyof ComputerRow, number>; headers: string[] } {
  const grid = parseCsv(text);
  if (!grid.length) return { rows: [], mapping: mapHeaders([]), headers: [] };
  const headers = grid[0];
  const mapping = mapHeaders(headers);
  const at = (r: string[], i: number) => (i >= 0 && i < r.length ? String(r[i] || '').trim() : '');
  const rows = grid.slice(1).map((r) => ({
    device_name: at(r, mapping.device_name),
    serial: at(r, mapping.serial),
    model: at(r, mapping.model),
    user: at(r, mapping.user),
    email: at(r, mapping.email),
    os: at(r, mapping.os),
    last_seen: at(r, mapping.last_seen),
  }));
  return { rows, mapping, headers };
}

const normEmail = (s: string) => (s || '').trim().toLowerCase();
const normName = (s: string) => (s || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

interface EmpIndex {
  byEmail: Map<string, { id: number; name: string }>;
  byUsername: Map<string, { id: number; name: string }>;
  byName: Map<string, { id: number; name: string }>;
  size: number;
}
const localPart = (s: string) => String(s || '').split('@')[0].trim().toLowerCase();
function buildEmployeeIndex(): EmpIndex {
  const rows = getDb()
    .prepare(`SELECT id, legal_first_name, legal_last_name, preferred_name, work_email, personal_email, upn, ad_username FROM employees`)
    .all() as any[];
  const byEmail = new Map<string, { id: number; name: string }>();
  const byUsername = new Map<string, { id: number; name: string }>();
  const byName = new Map<string, { id: number; name: string }>();
  const put = (map: Map<string, any>, key: string, rec: any) => { const k = (key || '').trim().toLowerCase(); if (k && !map.has(k)) map.set(k, rec); };
  for (const e of rows) {
    const name = `${e.preferred_name || e.legal_first_name || ''} ${e.legal_last_name || ''}`.trim();
    const rec = { id: e.id as number, name };
    for (const em of [e.work_email, e.personal_email, e.upn]) if (em) put(byEmail, normEmail(em), rec);
    // Handles the RMM might carry as "Last Logged in User": AD username, or the email/UPN local part.
    for (const handle of [e.ad_username, localPart(e.upn), localPart(e.work_email), localPart(e.personal_email)]) if (handle) put(byUsername, handle, rec);
    // Synthetic first.last / flast / firstlast from the name, since AD usernames usually follow the
    // name and many rows have no email column at all.
    const first = String(e.preferred_name || e.legal_first_name || '').trim().toLowerCase().split(/\s+/)[0];
    const last = String(e.legal_last_name || '').trim().toLowerCase().split(/\s+/).pop() || '';
    if (first && last) { put(byUsername, `${first}.${last}`, rec); put(byUsername, `${first}${last}`, rec); put(byUsername, `${first[0]}${last}`, rec); }
    const nk = normName(name);
    if (nk) put(byName, nk, rec);
  }
  return { byEmail, byUsername, byName, size: rows.length };
}

/** Best-effort match of one computer row to an employee. Handles the common RMM shapes: an email
 *  column, or a "DOMAIN\\first.last" / "COMPUTER\\first.last" logged-in-user string. A dotted
 *  username is also tried as a full name ("devon.booker" -> "devon booker"). Null when unsure. */
function matchEmployee(row: ComputerRow, idx: EmpIndex): { id: number; name: string } | null {
  if (row.email) {
    const e = idx.byEmail.get(normEmail(row.email));
    if (e) return e;
    const local = localPart(row.email);
    if (local) { const u = idx.byUsername.get(local); if (u) return u; }
  }
  if (row.user) {
    // Strip any "DOMAIN\\" or "COMPUTERNAME\\" prefix, keep just the account name.
    const uname = row.user.trim().replace(/^.*\\/, '').trim().toLowerCase();
    if (uname) {
      const u = idx.byUsername.get(uname);
      if (u) return u;
      // "first.last" (or "first_last") -> treat as a display name too.
      if (/[._]/.test(uname)) {
        const asName = normName(uname.replace(/[._]+/g, ' '));
        const n = idx.byName.get(asName);
        if (n) return n;
      }
      const n2 = idx.byName.get(normName(row.user));
      if (n2) return n2;
    }
  }
  return null;
}

export interface ImportPreviewRow {
  device_name: string;
  serial: string;
  model: string;
  os: string;
  rmm_user: string;
  matched_to: string | null;
  action: 'create' | 'update' | 'skip';
  reason?: string;
}
export interface ImportResult {
  ok: boolean;
  error?: string;
  committed: boolean;
  headers: string[];
  recognized: string[]; // which ComputerRow fields we found columns for
  total: number;
  matched: number;
  unmatched: number;
  created: number;
  updated: number;
  employeeCount: number; // employees available to match against (0 => import the roster first)
  rows: ImportPreviewRow[];
}

function assetNote(row: ComputerRow): string {
  return [row.user && `RMM user: ${row.user}`, row.model && `Model: ${row.model}`, row.os && `OS: ${row.os}`, row.last_seen && `Last seen: ${row.last_seen}`, 'Source: RMM']
    .filter(Boolean)
    .join(' · ');
}

/**
 * Parse the CSV, match every machine to an employee, and either preview or write employee_assets.
 * A machine already present (same serial, or same device name when serial is blank) is updated in
 * place. Assets that match no employee are still recorded, unassigned, so nothing is lost.
 */
export function importComputers(csv: string, actor: string, commit: boolean): ImportResult {
  const { rows, mapping, headers } = rowsFromCsv(csv || '');
  const recognized = (Object.keys(mapping) as (keyof ComputerRow)[]).filter((k) => mapping[k] >= 0);
  if (!rows.length) return { ok: false, error: 'No data rows found in the file.', committed: false, headers, recognized, total: 0, matched: 0, unmatched: 0, created: 0, updated: 0, employeeCount: 0, rows: [] };
  if (mapping.device_name < 0 && mapping.serial < 0) {
    return { ok: false, error: 'Could not find a device-name or serial-number column. Check the header row.', committed: false, headers, recognized, total: rows.length, matched: 0, unmatched: 0, created: 0, updated: 0, employeeCount: 0, rows: [] };
  }
  const db = getDb();
  const idx = buildEmployeeIndex();
  const findExisting = db.prepare(`SELECT id, employee_id FROM employee_assets WHERE asset_type = 'computer' AND ((serial IS NOT NULL AND serial != '' AND serial = ?) OR ((serial IS NULL OR serial = '') AND device_name = ?)) LIMIT 1`);
  const insert = db.prepare(`INSERT INTO employee_assets (employee_id, asset_type, identifier, serial, device_name, status, owner, assigned_at, notes) VALUES (?, 'computer', ?, ?, ?, ?, 'it', ?, ?)`);
  const update = db.prepare(`UPDATE employee_assets SET employee_id = ?, identifier = ?, serial = ?, device_name = ?, status = ?, notes = ? WHERE id = ?`);

  let matched = 0, unmatched = 0, created = 0, updated = 0;
  const preview: ImportPreviewRow[] = [];

  const apply = db.transaction(() => {
    for (const r of rows) {
      const emp = matchEmployee(r, idx);
      if (emp) matched++; else unmatched++;
      const status = emp ? 'assigned' : 'available';
      const serial = r.serial || '';
      const device = r.device_name || r.serial || '(unnamed device)';
      const existing = findExisting.get(serial, device) as { id: number } | undefined;
      const action: ImportPreviewRow['action'] = existing ? 'update' : 'create';
      preview.push({ device_name: device, serial, model: r.model, os: r.os, rmm_user: r.user || r.email, matched_to: emp ? emp.name : null, action });
      if (!commit) continue;
      const note = assetNote(r);
      if (existing) { update.run(emp ? emp.id : null, serial || device, serial, device, status, note, existing.id); updated++; }
      else { insert.run(emp ? emp.id : null, serial || device, serial, device, status, emp ? new Date().toISOString() : null, note); created++; }
      if (emp) audit('asset_imported', `RMM: ${device}${serial ? ` (${serial})` : ''}`, { actor, employee_id: emp.id });
    }
  });

  if (commit) apply(); else {
    // dry run: still compute preview + counts without writing
    for (const r of rows) {
      const emp = matchEmployee(r, idx);
      if (emp) matched++; else unmatched++;
      const serial = r.serial || '';
      const device = r.device_name || r.serial || '(unnamed device)';
      const existing = findExisting.get(serial, device) as { id: number } | undefined;
      preview.push({ device_name: device, serial, model: r.model, os: r.os, rmm_user: r.user || r.email, matched_to: emp ? emp.name : null, action: existing ? 'update' : 'create' });
    }
  }

  return { ok: true, committed: commit, headers, recognized, total: rows.length, matched, unmatched, created, updated, employeeCount: idx.size, rows: preview.slice(0, 300) };
}
