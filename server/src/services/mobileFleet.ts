/**
 * Phones & iPads: who has which carrier line and device, what it costs, and what to cut.
 *
 * Two sources fill it:
 *   1. The AT&T Premier "detail report" CSV (one row per wireless number). This is the source of truth
 *      for what AT&T is actually billing: status, plan, contract, installment, upgrade eligibility,
 *      and the device IMEI actually on the network.
 *   2. The office's own device workbook (one tab per AT&T account). This is the source for who has
 *      what: the employee per line, serial numbers, device balances and the free-text history. The
 *      browser reads the workbook and strips every password and passcode column before upload; this
 *      module drops them again as a second guard. Nothing here stores a credential.
 *
 * The read model joins lines to employees, the device asset, the Apple device mirror (ABM + Addigy)
 * and Teams voice, and computes the flags IT acts on. Imports preview by default (commit = false).
 */
import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { audit } from '../people/service';
import { canonicalOffice, officeLabel } from '../os/office';
import { parseCsv } from './rmmImport';

/* ─────────────────────────── normalizers ─────────────────────────── */

/** Last 10 digits of a US number, or '' when it is not a phone number. */
export function normNumber(s: unknown): string {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}
export function fmtNumber(n: string): string {
  return n && n.length === 10 ? `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}` : n;
}
/** Uppercase, accents folded, punctuation and generational suffixes dropped: "Joshua Peña" -> "JOSHUA PENA". */
export function normPersonName(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/�/g, 'N') // a mangled ñ in an older export
    .toUpperCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(JR|SR|II|III|IV)\b\.?/g, ' ')
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/** MM/DD/YYYY, M/D/YY, YYYY-MM-DD or an Excel serial -> YYYY-MM-DD; '' when not a date. */
export function normDate(s: unknown): string {
  const v = String(s ?? '').trim();
  if (!v) return '';
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return '';
}
function money(s: unknown): number | null {
  const v = String(s ?? '').replace(/[$,\s]/g, '');
  if (!v || !/^-?\d+(\.\d+)?$/.test(v)) return null;
  return Number(v);
}
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const SECRET_HEADER = /password|passcode|device code|\bpin\b/i;

/** Devices that no longer get the current iOS / iPadOS, so an MDM cannot fully manage them. */
export function unsupportedModel(model: string): boolean {
  return /iphone\s*(5|6|7|8|x\b|xr|xs|se\b(?!.*(2020|2022|2nd|3rd|a2275|a2296|a2298|a2595|a2782|a2783|a2784|a2785)))|ipad\s*(\(?\s*)?(2|3|4|5|6)(th)?\s*gen|ipad\s*(5|6)\b/i.test(model || '');
}
function kindFromAtt(deviceType: string, make: string): string {
  const t = deviceType.toLowerCase();
  if (t === 'tablet') return 'tablet';
  if (t === 'phone') return 'phone';
  if (t === 'wearable') return 'watch';
  if (t.includes('connected') || /netgear|nighthawk/i.test(make)) return 'hotspot';
  return 'other';
}
function assetTypeFor(kind: string): string | null {
  return kind === 'phone' ? 'company_phone' : kind === 'tablet' ? 'ipad' : null;
}
function offset(isoDay: string, days: number): string {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
const today = () => new Date().toISOString().slice(0, 10);

/* ─────────────────────────── employee matching ─────────────────────────── */

interface EmpRec { id: number; name: string; status: string; office: string | null }
interface EmpIndex { byName: Map<string, EmpRec>; byFirstLast: Map<string, EmpRec[]>; byPhone: Map<string, EmpRec>; byEmail: Map<string, EmpRec>; size: number }

function buildIndex(): EmpIndex {
  const rows = getDb().prepare(
    `SELECT id, legal_first_name, legal_last_name, preferred_name, entra_display_name, work_email, upn, personal_phone, office, employment_status FROM employees`
  ).all() as any[];
  const idx: EmpIndex = { byName: new Map(), byFirstLast: new Map(), byPhone: new Map(), byEmail: new Map(), size: rows.length };
  // Terminated people sort last so an active namesake wins a name match.
  rows.sort((a, b) => (a.employment_status === 'terminated' ? 1 : 0) - (b.employment_status === 'terminated' ? 1 : 0));
  for (const e of rows) {
    const name = String(e.entra_display_name || `${e.preferred_name || e.legal_first_name || ''} ${e.legal_last_name || ''}`).trim();
    const rec: EmpRec = { id: e.id, name, status: e.employment_status || '', office: e.office || null };
    const names = [name, `${e.legal_first_name || ''} ${e.legal_last_name || ''}`, `${e.preferred_name || ''} ${e.legal_last_name || ''}`];
    for (const n of names) {
      const k = normPersonName(n);
      if (k && !idx.byName.has(k)) idx.byName.set(k, rec);
      const parts = k.split(' ');
      if (parts.length >= 2) {
        const fl = `${parts[0]} ${parts[parts.length - 1]}`;
        const list = idx.byFirstLast.get(fl) || [];
        if (!list.some((r) => r.id === rec.id)) list.push(rec);
        idx.byFirstLast.set(fl, list);
      }
    }
    const ph = normNumber(e.personal_phone);
    if (ph && !idx.byPhone.has(ph)) idx.byPhone.set(ph, rec);
    for (const em of [e.work_email, e.upn]) if (em) idx.byEmail.set(String(em).toLowerCase(), rec);
  }
  return idx;
}
function matchName(idx: EmpIndex, raw: string, number?: string): { emp: EmpRec | null; how: string } {
  const k = normPersonName(raw.replace(/\s+-\s+.*$/, '')); // "JUSTIN DEES - VDS" -> "JUSTIN DEES"
  if (k) {
    const exact = idx.byName.get(k);
    if (exact) return { emp: exact, how: 'name' };
    const parts = k.split(' ');
    if (parts.length >= 2) {
      const list = idx.byFirstLast.get(`${parts[0]} ${parts[parts.length - 1]}`) || [];
      if (list.length === 1) return { emp: list[0], how: 'first and last name' };
    }
  }
  if (number) {
    const p = idx.byPhone.get(number);
    if (p) return { emp: p, how: 'mobile number on file' };
  }
  return { emp: null, how: '' };
}

/* ─────────────────────────── line + device persistence ─────────────────────────── */

function lineByNumber(n: string): any {
  return getDb().prepare(`SELECT * FROM mobile_lines WHERE number = ?`).get(n);
}
export function logEvent(lineId: number, kind: string, detail: string, actor: string, employeeId: number | null = null): void {
  getDb().prepare(`INSERT INTO mobile_line_events (line_id, kind, detail, employee_id, actor) VALUES (?, ?, ?, ?, ?)`)
    .run(lineId, kind, detail, employeeId, actor || 'system');
}
const LINE_COLS = new Set([
  'carrier', 'billing_account', 'billing_account_name', 'office', 'kind', 'employee_id', 'shared_label', 'holder_name', 'status', 'status_date',
  'carrier_status', 'in_latest_report', 'last_report_at', 'intent', 'intent_at', 'freeze_until', 'monthly_cost', 'rate_plan',
  'group_plan', 'activation_date', 'last_upgrade_date', 'upgrade_eligible', 'early_upgrade_eligible', 'upgrade_in_progress',
  'contract_type', 'contract_start', 'contract_end', 'contract_status', 'monthly_installment', 'device_balance', 'balance_as_of',
  'paid_off', 'device_asset_id', 'att_user_name', 'att_email', 'imei', 'att_imei', 'iccid', 'sim_type', 'device_make',
  'device_model', 'os_version', 'imei_mismatch', 'apple_account', 'notes',
]);
function writeLine(number: string, fields: Record<string, unknown>): number {
  const db = getDb();
  const keys = Object.keys(fields).filter((k) => LINE_COLS.has(k));
  const existing = lineByNumber(number);
  if (existing) {
    if (keys.length) {
      db.prepare(`UPDATE mobile_lines SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`)
        .run({ ...pick(fields, keys), id: existing.id });
    }
    return existing.id;
  }
  const cols = ['number', ...keys];
  const info = db.prepare(`INSERT INTO mobile_lines (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`)
    .run({ number, ...pick(fields, keys) });
  return Number(info.lastInsertRowid);
}
function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = o[k] === undefined ? null : typeof o[k] === 'boolean' ? (o[k] ? 1 : 0) : o[k];
  return out;
}

/**
 * Make sure the device in a line has an employee_assets row and the line points at it. A device is
 * found by IMEI first, then serial. When the line already pointed at a different device (a swap), the
 * old asset is unlinked, not deleted, and the swap is written to the line's history.
 */
function ensureDevice(lineId: number, d: { kind: string; imei: string; serial: string; model: string; employeeId: number | null; purchase: string; source: string }, actor: string): number | null {
  const type = assetTypeFor(d.kind);
  if (!type || (!d.imei && !d.serial)) return null;
  const db = getDb();
  const line = db.prepare(`SELECT device_asset_id, employee_id FROM mobile_lines WHERE id = ?`).get(lineId) as any;
  let asset: any = null;
  if (d.imei) asset = db.prepare(`SELECT * FROM employee_assets WHERE imei = ? ORDER BY id DESC LIMIT 1`).get(d.imei);
  if (!asset && d.serial) asset = db.prepare(`SELECT * FROM employee_assets WHERE serial = ? AND asset_type IN ('company_phone','ipad') ORDER BY id DESC LIMIT 1`).get(d.serial);
  if (!asset && line?.device_asset_id) {
    const linked = db.prepare(`SELECT * FROM employee_assets WHERE id = ?`).get(line.device_asset_id) as any;
    // The linked device has no IMEI yet (workbook-only); adopt it instead of making a duplicate.
    if (linked && (!linked.imei || linked.imei === d.imei)) asset = linked;
  }
  const holder = d.employeeId ?? line?.employee_id ?? null;
  const name = d.model || (type === 'ipad' ? 'iPad' : 'Phone');
  if (asset) {
    db.prepare(`UPDATE employee_assets SET imei = COALESCE(NULLIF(?, ''), imei), serial = COALESCE(NULLIF(?, ''), serial), model = COALESCE(NULLIF(?, ''), model),
      device_name = COALESCE(device_name, ?), purchase_date = COALESCE(NULLIF(?, ''), purchase_date), line_id = ?, identifier = COALESCE(identifier, ?) WHERE id = ?`)
      .run(d.imei, d.serial, d.model, name, d.purchase, lineId, d.imei ? `IMEI ${d.imei.slice(-4)}` : d.serial, asset.id);
  } else {
    const info = db.prepare(`INSERT INTO employee_assets (employee_id, asset_type, identifier, serial, device_name, status, owner, assigned_at, notes, imei, model, line_id, purchase_date, source)
      VALUES (?, ?, ?, ?, ?, ?, 'it', ?, ?, ?, ?, ?, ?, ?)`)
      .run(holder, type, d.imei ? `IMEI ${d.imei.slice(-4)}` : d.serial, d.serial || null, name, holder ? 'assigned' : 'available',
        holder ? new Date().toISOString() : null, `Source: ${d.source}`, d.imei || null, d.model || null, lineId, d.purchase || null, d.source);
    asset = { id: Number(info.lastInsertRowid) };
  }
  if (line?.device_asset_id && line.device_asset_id !== asset.id) {
    const old = db.prepare(`SELECT id, imei, model FROM employee_assets WHERE id = ?`).get(line.device_asset_id) as any;
    db.prepare(`UPDATE employee_assets SET line_id = NULL WHERE id = ?`).run(line.device_asset_id);
    if (old) logEvent(lineId, 'device_swap', `Device in this line changed: ${old.model || 'device'}${old.imei ? ` (IMEI ...${old.imei.slice(-4)})` : ''} -> ${d.model || 'device'}${d.imei ? ` (IMEI ...${d.imei.slice(-4)})` : ''}`, actor);
  }
  db.prepare(`UPDATE mobile_lines SET device_asset_id = ? WHERE id = ?`).run(asset.id, lineId);
  return asset.id;
}

/* ─────────────────────────── 1. AT&T detail report ─────────────────────────── */

const ATT_COLS = {
  number: 'wireless number', ban: 'billing account number', banName: 'billing account name', user: 'wireless user name',
  status: 'status', statusDate: 'status effective date', deviceType: 'device type', imei: 'device imei', make: 'device make',
  model: 'device model', mismatch: 'network imei mismatch', netImei: 'device imei (network)', netMake: 'device make (network)',
  netModel: 'device model (network)', os: 'operating system version', simType: 'sim type', iccid: 'sim number (iccid)',
  ratePlan: 'rate plan soc: name', groupPlan: 'group plan soc: name', activation: 'activation date', lastUpgrade: 'last upgrade date',
  upgradeInProgress: 'upgrade in progress', contractType: 'contract type', contractStart: 'contract start date',
  contractEnd: 'contract end date', contractStatus: 'contract status', iphoneElig: 'iphone upgrade eligibility',
  smartElig: 'smartphone upgrade eligibility', earlyElig: 'early iphone upgrade eligibility', installment: 'monthly installment',
  payoff: 'installment pay off', email: 'email address', updated: 'last updated date',
} as const;
type AttKey = keyof typeof ATT_COLS;

export interface AttRow {
  number: string; ban: string; banName: string; office: string; user: string; status: string; statusDate: string; kind: string;
  imei: string; attImei: string; mismatch: boolean; make: string; model: string; os: string; simType: string; iccid: string;
  ratePlan: string; groupPlan: string; activation: string; lastUpgrade: string; upgradeInProgress: boolean; contractType: string;
  contractStart: string; contractEnd: string; contractStatus: string; upgradeEligible: string; earlyEligible: string;
  installment: number | null; payoff: number | null; email: string; reportDate: string;
}
function plan(soc: string): string {
  return clean(soc.replace(/^[A-Z0-9]+:/, ''));
}
function eligibility(v: string): string {
  const s = clean(v);
  if (/^yes$/i.test(s)) return 'yes';
  if (/^no$/i.test(s) || !s) return '';
  return normDate(s);
}
function carrierStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (/cancel|deactiv|disconnect/.test(s)) return 'cancelled';
  if (/suspend|freeze|frozen/.test(s)) return 'suspended';
  return 'active';
}

export function parseAttReport(csv: string): { ok: boolean; error?: string; rows: AttRow[] } {
  const grid = parseCsv(csv || '');
  if (!grid.length) return { ok: false, error: 'The file is empty.', rows: [] };
  const head = grid[0].map((h) => h.trim().toLowerCase());
  const at: Record<string, number> = {};
  (Object.keys(ATT_COLS) as AttKey[]).forEach((k) => (at[k] = head.indexOf(ATT_COLS[k])));
  if (at.number < 0 || at.ban < 0) {
    return { ok: false, error: 'This does not look like the AT&T detail report: no "Wireless number" and "Billing account number" columns.', rows: [] };
  }
  const v = (r: string[], k: AttKey) => (at[k] >= 0 ? clean(r[at[k]]) : '');
  const rows: AttRow[] = [];
  for (const r of grid.slice(1)) {
    const number = normNumber(v(r, 'number'));
    if (!number) continue;
    const mismatch = /^yes$/i.test(v(r, 'mismatch')) && !!digits(v(r, 'netImei'));
    const attImei = digits(v(r, 'imei'));
    const elig = eligibility(v(r, 'iphoneElig')) || eligibility(v(r, 'smartElig'));
    rows.push({
      number, ban: v(r, 'ban'), banName: v(r, 'banName'), office: canonicalOffice(v(r, 'banName')), user: v(r, 'user'),
      status: carrierStatus(v(r, 'status')), statusDate: normDate(v(r, 'statusDate')),
      kind: kindFromAtt(v(r, 'deviceType'), v(r, 'make')),
      imei: mismatch ? digits(v(r, 'netImei')) : attImei, attImei, mismatch,
      make: mismatch && v(r, 'netMake') ? v(r, 'netMake') : v(r, 'make'),
      model: mismatch && v(r, 'netModel') ? v(r, 'netModel') : v(r, 'model'),
      os: v(r, 'os'), simType: v(r, 'simType'), iccid: digits(v(r, 'iccid')),
      ratePlan: plan(v(r, 'ratePlan')), groupPlan: plan(v(r, 'groupPlan')), activation: normDate(v(r, 'activation')),
      lastUpgrade: normDate(v(r, 'lastUpgrade')), upgradeInProgress: /^yes$/i.test(v(r, 'upgradeInProgress')),
      contractType: v(r, 'contractType'), contractStart: normDate(v(r, 'contractStart')), contractEnd: normDate(v(r, 'contractEnd')),
      contractStatus: v(r, 'contractStatus'), upgradeEligible: elig, earlyEligible: eligibility(v(r, 'earlyElig')),
      installment: money(v(r, 'installment')), payoff: money(v(r, 'payoff')), email: v(r, 'email').toLowerCase(),
      reportDate: normDate(v(r, 'updated')) || today(),
    });
  }
  return { ok: true, rows };
}

/** Months of installments left on a device: whole months from today to the contract end, at least 0. */
export function installmentRemaining(monthly: number | null, contractEnd: string, contractStatus: string, asOf = today()): number | null {
  if (!monthly || !contractEnd || /complete/i.test(contractStatus)) return monthly ? 0 : null;
  const [y1, m1, d1] = asOf.split('-').map(Number);
  const [y2, m2, d2] = contractEnd.split('-').map(Number);
  let months = (y2 - y1) * 12 + (m2 - m1) + (d2 > d1 ? 1 : 0);
  if (months < 0) months = 0;
  return Math.round(monthly * months * 100) / 100;
}

export interface ImportSummary {
  ok: boolean; error?: string; committed: boolean; total: number; created: number; updated: number;
  unchanged?: number; accounts: string[]; missingFromReport: number; rows: any[];
}

export function importAttReport(csv: string, actor: string, commit: boolean): ImportSummary {
  const parsed = parseAttReport(csv);
  if (!parsed.ok) return { ok: false, error: parsed.error, committed: false, total: 0, created: 0, updated: 0, accounts: [], missingFromReport: 0, rows: [] };
  const db = getDb();
  const accounts = [...new Set(parsed.rows.map((r) => r.ban).filter(Boolean))];
  const inReport = new Set(parsed.rows.map((r) => r.number));
  const missing = accounts.length
    ? (db.prepare(`SELECT number FROM mobile_lines WHERE status != 'cancelled' AND billing_account IN (${accounts.map(() => '?').join(',')})`).all(...accounts) as any[])
        .filter((l) => !inReport.has(l.number)).length
    : 0;
  let created = 0, updated = 0;
  const preview = parsed.rows.map((r) => {
    const ex = lineByNumber(r.number);
    if (ex) updated++; else created++;
    return { number: fmtNumber(r.number), account: r.banName, office: officeLabel(r.office), kind: r.kind, model: r.model, status: r.status, action: ex ? 'update' : 'create', imei_changed: !!(ex && ex.imei && r.imei && ex.imei !== r.imei) };
  });
  if (commit) {
    const tx = db.transaction(() => {
      if (accounts.length) db.prepare(`UPDATE mobile_lines SET in_latest_report = 0 WHERE billing_account IN (${accounts.map(() => '?').join(',')})`).run(...accounts);
      for (const r of parsed.rows) {
        const before = lineByNumber(r.number);
        const balance = installmentRemaining(r.installment, r.contractEnd, r.contractStatus, r.reportDate);
        const id = writeLine(r.number, {
          carrier: 'att', billing_account: r.ban, billing_account_name: r.banName, office: r.office || before?.office || null,
          kind: r.kind, status: r.status, status_date: r.statusDate || null, carrier_status: r.status, in_latest_report: 1,
          last_report_at: r.reportDate, rate_plan: r.ratePlan || null, group_plan: r.groupPlan || null,
          activation_date: r.activation || null, last_upgrade_date: r.lastUpgrade || null, upgrade_eligible: r.upgradeEligible || null,
          early_upgrade_eligible: r.earlyEligible || null, upgrade_in_progress: r.upgradeInProgress ? 1 : 0,
          contract_type: r.contractType || null, contract_start: r.contractStart || null, contract_end: r.contractEnd || null,
          contract_status: r.contractStatus || null, monthly_installment: r.installment,
          // AT&T's own payoff when given; otherwise installments left. A finished or no-contract line owes nothing.
          ...(r.payoff != null ? { device_balance: r.payoff, balance_as_of: r.reportDate }
            : balance != null ? { device_balance: balance, balance_as_of: r.reportDate } : {}),
          ...(r.payoff === 0 || balance === 0 || /complete|no contract/i.test(`${r.contractStatus} ${r.contractType}`) ? { paid_off: 1 } : r.installment ? { paid_off: 0 } : {}),
          att_user_name: r.user || null, att_email: r.email || null, imei: r.imei || null, att_imei: r.attImei || null,
          iccid: r.iccid || null, sim_type: r.simType || null, device_make: r.make || null, device_model: r.model || null,
          os_version: r.os || null, imei_mismatch: r.mismatch ? 1 : 0,
        });
        if (!before) logEvent(id, 'import', `Added from the AT&T report (${r.banName || r.ban})`, actor);
        else if (before.status !== r.status) logEvent(id, r.status === 'cancelled' ? 'cancel' : r.status === 'suspended' ? 'freeze' : 'reactivate', `AT&T status changed: ${before.status} -> ${r.status}`, actor);
        if (before && before.last_upgrade_date !== (r.lastUpgrade || null) && r.lastUpgrade) logEvent(id, 'upgrade', `AT&T shows an upgrade on ${r.lastUpgrade}`, actor);
        // Once AT&T confirms the change the office asked for, the intent is done.
        if (before?.intent === 'cancel' && r.status === 'cancelled') db.prepare(`UPDATE mobile_lines SET intent = NULL WHERE id = ?`).run(id);
        if (before?.intent === 'freeze' && r.status === 'suspended') db.prepare(`UPDATE mobile_lines SET intent = NULL WHERE id = ?`).run(id);
        ensureDevice(id, { kind: r.kind, imei: r.imei, serial: '', model: r.model, employeeId: null, purchase: r.contractStart, source: 'AT&T report' }, actor);
      }
    });
    tx();
    setState('mobile.att_report_at', parsed.rows[0]?.reportDate || today());
    audit('mobile_att_import', `AT&T report: ${parsed.rows.length} lines across ${accounts.length} account(s)`, { actor });
  }
  return { ok: true, committed: commit, total: parsed.rows.length, created, updated, accounts, missingFromReport: missing, rows: preview.slice(0, 400) };
}

/* ─────────────────────────── 2. the office device workbook ─────────────────────────── */

/** Workbook tab name -> office key, for lines AT&T no longer reports (cancelled history). */
const SHEET_OFFICE: Record<string, string> = {
  cstat: 'college-station', cst: 'college-station', ext: 'extinguishers', hou: 'houston', lar: 'laredo', waco: 'waco',
  lub: 'lubbock', mgmt: 'management', aus: 'austin', mca: 'mcallen', fps: 'services', osc: 'one-stop-code-consulting',
};
const JUNK_ROW = /^(first name|last name|dob|\*|only \d|\d+ new|\d+ old|new ipads|returned ipads|\d+\.$)/i;
const SHARED_ROW = /\bLINE\b|SERVICE|LOCAL NUMBER|HOT ?SPOT|DATA|M&I|ACCOUNTING|^HR\b|LOANER|PURCHASING|OFFICE/i;

export type WorkbookStatus = 'assigned' | 'shared' | 'spare' | 'frozen' | 'cancelled' | 'old_account';
export interface WorkbookRow {
  sheet: string; office: string; employee: string; number: string; status: WorkbookStatus; kind: string; model: string;
  serial: string; imei: string; purchase: string; paidOff: boolean; balance: number | null; appleAccount: string; notes: string;
}
export interface WorkbookSheet { name: string; rows: unknown[][] }

/** Turn the workbook's tabs into one clean row per device/line. Secrets never survive this function. */
export function parseWorkbook(sheets: WorkbookSheet[]): WorkbookRow[] {
  const out: WorkbookRow[] = [];
  for (const sh of sheets || []) {
    const grid = (sh.rows || []).map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : []));
    const hIdx = grid.findIndex((r) => r.some((c) => /^employee$/i.test(c.trim())) && r.some((c) => /phone number/i.test(c)));
    if (hIdx < 0) continue;
    const head = grid[hIdx].map((h) => h.trim().toLowerCase());
    const col = (re: RegExp) => head.findIndex((h) => re.test(h) && !SECRET_HEADER.test(h));
    const c = {
      emp: col(/^employee$/), num: col(/phone number/), ipad: col(/^ipad$/), iphone: col(/^iphone$/), watch: col(/^watch$/),
      model: col(/^model$/), serial: col(/serial/), imei: col(/^imei$/), purchase: col(/date of purchase|purchase date/),
      paid: col(/paid.?off/), bal: col(/^balance/), apple: col(/apple id/), inactive: col(/^inactive$/), notes: col(/^notes$/),
    };
    const termed = /termed/i.test(sh.name);
    const office = SHEET_OFFICE[sh.name.toLowerCase().replace(/[^a-z]/g, '')] || '';
    let section: 'assigned' | 'spare' | 'cancelled' = 'assigned';
    const get = (r: string[], i: number) => (i >= 0 && i < r.length ? clean(r[i]) : '');
    for (const r of grid.slice(hIdx + 1)) {
      const emp = get(r, c.emp), up = emp.toUpperCase();
      const raw = get(r, c.num);
      if (/CANCEL+ED LINES/.test(up)) { section = 'cancelled'; continue; }
      if (/AVAILABLE TO USE/.test(up)) { section = 'spare'; continue; }
      if (!r.some((x) => clean(x)) || JUNK_ROW.test(emp)) continue;
      const number = normNumber(raw);
      const model = get(r, c.model);
      if (!number && !model) continue;
      if (termed && !number) continue;
      const notes = get(r, c.notes), nu = notes.toUpperCase();
      const inactive = get(r, c.inactive).toUpperCase();
      const flag = (i: number) => /^x$/i.test(get(r, i));
      let kind = flag(c.ipad) ? 'tablet' : flag(c.watch) ? 'watch' : flag(c.iphone) ? 'phone' : /netgear|hot ?spot/i.test(`${model} ${emp}`) ? 'hotspot' : /data/i.test(`${emp} ${notes}`) ? 'data' : 'other';
      if (kind === 'other' && /iphone|galaxy|samsung/i.test(model)) kind = 'phone';
      if (kind === 'other' && /ipad/i.test(model)) kind = 'tablet';
      let status: WorkbookStatus;
      if (termed) status = 'old_account';
      else if (section === 'cancelled' || /^CANCEL/.test(up) || inactive === 'X' || /LINE (CANCEL+ED|DISCONNECTED|RELEASED)|CANCELLED LINE|LINE CANCELED/.test(nu)) status = 'cancelled';
      else if (/FREEZE/.test(inactive) || /FROZE/.test(nu)) status = 'frozen';
      else if (section === 'spare' || /^(UNASSIGNED|\?|)$/.test(up)) status = 'spare';
      else if (SHARED_ROW.test(up)) status = 'shared';
      else status = 'assigned';
      const appleRaw = get(r, c.apple);
      out.push({
        sheet: sh.name, office, employee: emp, number, status, kind, model,
        serial: get(r, c.serial).replace(/\s+/g, '').toUpperCase(), imei: digits(get(r, c.imei)),
        purchase: normDate(get(r, c.purchase)), paidOff: /^x$/i.test(get(r, c.paid)), balance: money(get(r, c.bal)),
        appleAccount: /@/.test(appleRaw) ? appleRaw.toLowerCase() : '', notes,
      });
    }
  }
  return out;
}

const STATUS_RANK: Record<WorkbookStatus, number> = { assigned: 0, shared: 1, spare: 2, frozen: 3, cancelled: 4, old_account: 5 };

export function importWorkbook(sheets: WorkbookSheet[], actor: string, commit: boolean): ImportSummary & { matched: number; unmatched: number; employeeCount: number } {
  const rows = parseWorkbook(sheets);
  const empty = { committed: false, total: 0, created: 0, updated: 0, accounts: [], missingFromReport: 0, rows: [], matched: 0, unmatched: 0, employeeCount: 0 };
  if (!rows.length) return { ok: false, error: 'No device rows found. Each tab needs a header row with "Employee" and "Phone Number".', ...empty };
  // One row per number: the current assignment beats an old cancelled entry for the same number.
  const best = new Map<string, WorkbookRow>();
  for (const r of rows) {
    if (!r.number) continue;
    const prev = best.get(r.number);
    if (!prev || STATUS_RANK[r.status] < STATUS_RANK[prev.status]) best.set(r.number, r);
  }
  const idx = buildIndex();
  let matched = 0, unmatched = 0, created = 0, updated = 0;
  const preview: any[] = [];
  const plan = [...best.values()].map((r) => {
    const m = r.status === 'assigned' ? matchName(idx, r.employee, r.number) : { emp: null, how: '' };
    if (r.status === 'assigned') { if (m.emp) matched++; else unmatched++; }
    const ex = lineByNumber(r.number);
    if (ex) updated++; else created++;
    preview.push({
      number: fmtNumber(r.number), tab: r.sheet, employee: r.employee, status: r.status, kind: r.kind, model: r.model,
      matched_to: m.emp ? m.emp.name : null, how: m.how, action: ex ? 'update' : 'create',
      att_active: !!(ex && ex.status === 'active' && ex.in_latest_report), balance: r.balance,
    });
    return { r, emp: m.emp, ex };
  });
  if (commit) {
    const db = getDb();
    const tx = db.transaction(() => {
      for (const { r, emp, ex } of plan) {
        const fields: Record<string, unknown> = {
          office: ex?.office || r.office || null,
          kind: ex?.kind || r.kind,
          apple_account: r.appleAccount || ex?.apple_account || null,
        };
        if (r.status === 'assigned') { fields.employee_id = emp ? emp.id : null; fields.shared_label = null; fields.holder_name = emp ? null : r.employee; }
        else if (r.status === 'shared') { fields.employee_id = null; fields.shared_label = r.employee; fields.holder_name = null; }
        else if (r.status === 'spare' || r.status === 'frozen') { fields.employee_id = null; fields.shared_label = null; fields.holder_name = null; }
        // AT&T's installment math wins when the line is on the report; the workbook fills the gap otherwise.
        if (!ex?.in_latest_report) {
          if (r.balance != null) { fields.device_balance = r.balance; fields.balance_as_of = today(); }
          fields.paid_off = r.paidOff || r.balance === 0 ? 1 : r.balance ? 0 : null;
        }
        if (r.status === 'frozen') { fields.intent = 'freeze'; fields.intent_at = today(); }
        if (r.status === 'cancelled' || r.status === 'old_account') {
          if (ex && ex.status === 'active' && ex.in_latest_report) { fields.intent = 'cancel'; fields.intent_at = today(); }
          else if (!ex) { fields.status = 'cancelled'; fields.carrier_status = 'cancelled'; }
        }
        if (!ex) fields.status = fields.status || (r.status === 'frozen' ? 'suspended' : 'active');
        if (r.notes && !(ex?.notes || '').includes(r.notes)) fields.notes = [ex?.notes, r.notes].filter(Boolean).join('\n');
        const id = writeLine(r.number, fields);
        const who = emp ? emp.name : r.employee || r.status;
        logEvent(id, 'import', `From the device workbook (${r.sheet}): ${who}${r.status !== 'assigned' ? ` [${r.status.replace('_', ' ')}]` : ''}`, actor, emp ? emp.id : null);
        if (/UPGRADE/i.test(r.notes)) logEvent(id, 'upgrade', r.notes, actor);
        if (r.status !== 'cancelled' && r.status !== 'old_account') {
          // On a reported line AT&T knows which device is really in the SIM; the workbook's IMEI and serial
          // only apply when they describe that same device (a stale row must not register a fake swap).
          const onReport = !!(ex && ex.in_latest_report && ex.imei);
          const sameDevice = !onReport || !r.imei || r.imei === ex.imei;
          const assetId = ensureDevice(id, {
            kind: ex?.kind || r.kind, imei: onReport ? ex.imei : r.imei, serial: sameDevice ? r.serial : '',
            model: onReport ? ex.device_model || r.model : r.model, employeeId: emp ? emp.id : null,
            purchase: sameDevice ? r.purchase : '', source: 'device workbook',
          }, actor);
          if (assetId) {
            db.prepare(`UPDATE employee_assets SET employee_id = ?, status = ?, assigned_at = COALESCE(assigned_at, ?) WHERE id = ? AND status IN ('assigned','available')`)
              .run(emp ? emp.id : null, emp ? 'assigned' : 'available', emp ? new Date().toISOString() : null, assetId);
          }
        }
      }
    });
    tx();
    audit('mobile_workbook_import', `Device workbook: ${plan.length} lines, ${matched} matched to employees`, { actor });
  }
  return { ok: true, committed: commit, total: plan.length, created, updated, accounts: [], missingFromReport: 0, rows: preview.slice(0, 400), matched, unmatched, employeeCount: idx.size };
}

/* ─────────────────────────── read model ─────────────────────────── */

export interface LineFlag { key: string; label: string; tone: 'bad' | 'warn' | 'neutral' | 'good' }

function planCosts(): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of getDb().prepare(`SELECT plan, monthly_cost FROM mobile_plan_costs WHERE monthly_cost IS NOT NULL`).all() as any[]) m.set(p.plan, p.monthly_cost);
  return m;
}
export function billTotal(): number | null {
  const v = Number(getState('mobile.monthly_bill_total'));
  return Number.isFinite(v) && v > 0 ? v : null;
}
const COMPANY_DOMAIN = /@(1stfpservices\.com|1stfp\.com|icloud\.com)$/i;

export function listLines(opts: { includeCancelled?: boolean } = {}): { lines: any[]; summary: any } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT l.*, e.legal_first_name, e.legal_last_name, e.preferred_name, e.entra_display_name, e.employment_status, e.termination_date,
           a.serial AS asset_serial, a.model AS asset_model, a.status AS asset_status, a.employee_id AS asset_employee_id
    FROM mobile_lines l
    LEFT JOIN employees e ON e.id = l.employee_id
    LEFT JOIN employee_assets a ON a.id = l.device_asset_id
    ${opts.includeCancelled ? '' : `WHERE l.status != 'cancelled'`}
    ORDER BY l.office, l.kind, l.number`).all() as any[];
  const apple = new Map<string, any>(), appleByImei = new Map<string, any>();
  for (const d of db.prepare(`SELECT * FROM apple_devices`).all() as any[]) { apple.set(String(d.serial).toUpperCase(), d); if (d.imei) appleByImei.set(d.imei, d); }
  const teams = new Map<number, any>();
  for (const t of db.prepare(`SELECT * FROM teams_voice_users WHERE employee_id IS NOT NULL`).all() as any[]) teams.set(t.employee_id, t);
  const costs = planCosts();
  const addigyOn = !!getState('mobile.addigy_synced_at');
  const abmOn = !!getState('mobile.abm_synced_at');
  const attAt = getState('mobile.att_report_at');
  const now = today();

  const lines = rows.map((l) => {
    const employee = l.employee_id ? String(l.entra_display_name || `${l.preferred_name || l.legal_first_name || ''} ${l.legal_last_name || ''}`).trim() : null;
    const serial = String(l.asset_serial || '').toUpperCase();
    const ad = (serial && apple.get(serial)) || (l.imei && appleByImei.get(l.imei)) || null;
    const t = l.employee_id ? teams.get(l.employee_id) : null;
    const planCost = costs.get(l.group_plan || '') ?? costs.get(l.rate_plan || '') ?? null;
    const cost = l.monthly_cost ?? planCost;
    const model = l.device_model || l.asset_model || '';
    const apple_device = /apple|iphone|ipad/i.test(`${l.device_make} ${model}`);
    const flags: LineFlag[] = [];
    const active = l.status === 'active';
    if (active && l.intent === 'cancel') flags.push({ key: 'still_billing', label: 'AT&T still bills this line', tone: 'bad' });
    if (active && l.intent === 'freeze') flags.push({ key: 'freeze_pending', label: 'Freeze asked, AT&T shows active', tone: 'warn' });
    if (l.status === 'suspended') {
      const ends = l.freeze_until || (l.status_date ? offset(l.status_date, 182) : '');
      if (ends && ends <= offset(now, 45)) flags.push({ key: 'freeze_ending', label: `Freeze ends ${ends}`, tone: 'warn' });
    }
    if (active && !l.employee_id && !l.shared_label && !l.holder_name && l.intent !== 'cancel') flags.push({ key: 'spare', label: 'Paying for a spare line', tone: 'warn' });
    if (!l.employee_id && l.holder_name) flags.push({ key: 'unmatched', label: `Not matched to an employee: ${l.holder_name}`, tone: 'warn' });
    if (active && l.employee_id && /terminated|offboarding|notice/.test(l.employment_status || '')) flags.push({ key: 'termed_holder', label: `${l.employment_status === 'terminated' ? 'Terminated' : 'Leaving'}: still has this line`, tone: 'bad' });
    if (active && attAt && l.billing_account && !l.in_latest_report) flags.push({ key: 'not_in_report', label: 'Not on the latest AT&T report', tone: 'neutral' });
    if (l.imei_mismatch) flags.push({ key: 'imei_mismatch', label: 'A different device is in this SIM', tone: 'warn' });
    if (unsupportedModel(model)) flags.push({ key: 'too_old', label: 'Too old for current iOS', tone: 'warn' });
    if (apple_device && active && (l.kind === 'phone' || l.kind === 'tablet')) {
      if (!serial && !ad) flags.push({ key: 'no_serial', label: 'No serial number on file', tone: 'neutral' });
      if (addigyOn && !(ad && ad.in_addigy)) flags.push({ key: 'not_in_mdm', label: 'Not enrolled in Addigy', tone: 'warn' });
      if (abmOn && !(ad && ad.in_abm)) flags.push({ key: 'not_in_abm', label: 'Not in Apple Business Manager', tone: 'neutral' });
      if (ad && ad.in_addigy && ad.addigy_last_online && ad.addigy_last_online.slice(0, 10) < offset(now, -30)) flags.push({ key: 'stale_checkin', label: 'No MDM check-in for 30+ days', tone: 'warn' });
    }
    if (l.apple_account && !COMPANY_DOMAIN.test(l.apple_account)) flags.push({ key: 'personal_apple_id', label: 'Personal Apple ID on a company device', tone: 'warn' });
    if (active && l.kind === 'phone' && t && t.has_teams_phone) flags.push({ key: 'teams_overlap', label: 'Also has Teams Phone', tone: 'neutral' });
    const eligibleNow = l.upgrade_eligible === 'yes';
    return {
      id: l.id, number: l.number, number_fmt: fmtNumber(l.number), office: l.office, office_label: officeLabel(l.office || ''),
      account: l.billing_account_name, kind: l.kind, status: l.status, intent: l.intent, freeze_until: l.freeze_until,
      employee_id: l.employee_id, employee, employment_status: l.employment_status || null, shared_label: l.shared_label, holder_name: l.holder_name,
      att_user_name: l.att_user_name, model, make: l.device_make, os_version: l.os_version, imei: l.imei, serial: serial || (ad ? ad.serial : ''),
      sim_type: l.sim_type, plan: l.group_plan || l.rate_plan || '', monthly_cost: cost, cost_source: l.monthly_cost != null ? 'set on line' : planCost != null ? 'plan cost' : null,
      monthly_installment: l.monthly_installment, device_balance: l.device_balance, balance_as_of: l.balance_as_of, paid_off: l.paid_off,
      contract_end: l.contract_end, upgrade_eligible: l.upgrade_eligible, upgrade_eligible_now: eligibleNow, last_upgrade_date: l.last_upgrade_date,
      upgrade_in_progress: !!l.upgrade_in_progress, apple_account: l.apple_account, notes: l.notes,
      mdm: ad ? { in_addigy: !!ad.in_addigy, in_abm: !!ad.in_abm, last_online: ad.addigy_last_online, abm_status: ad.abm_status, abm_server: ad.abm_server, supervised: ad.addigy_supervised, addigy_user: ad.addigy_user } : null,
      teams: t ? { upn: t.upn, has_teams_phone: !!t.has_teams_phone, calls: t.call_count, pstn_calls: t.pstn_calls } : null,
      in_latest_report: !!l.in_latest_report, flags,
    };
  });

  // Average per-line cost from the monthly bill total, used only where no plan cost is set (shown as an estimate).
  const active = lines.filter((l) => l.status !== 'cancelled');
  const known = active.filter((l) => l.monthly_cost != null);
  const bill = billTotal();
  const avg = bill && active.length ? Math.round((bill / active.length) * 100) / 100 : null;
  for (const l of lines) if (l.monthly_cost == null && avg != null && l.status !== 'cancelled') { l.monthly_cost = avg; l.cost_source = 'estimate (bill / lines)'; }
  const flagged = (k: string) => active.filter((l) => l.flags.some((f: LineFlag) => f.key === k));
  const cutKeys = ['still_billing', 'spare', 'termed_holder'];
  const cut = active.filter((l) => l.flags.some((f: LineFlag) => cutKeys.includes(f.key)));
  const sum = (xs: any[], k: string) => Math.round(xs.reduce((s, x) => s + (Number(x[k]) || 0), 0) * 100) / 100;
  const byOffice: Record<string, { label: string; lines: number; phones: number; tablets: number }> = {};
  for (const l of active) {
    const o = (byOffice[l.office || ''] ||= { label: l.office_label, lines: 0, phones: 0, tablets: 0 });
    o.lines++; if (l.kind === 'phone') o.phones++; if (l.kind === 'tablet') o.tablets++;
  }
  const summary = {
    activeLines: active.filter((l) => l.status === 'active').length,
    suspendedLines: active.filter((l) => l.status === 'suspended').length,
    phones: active.filter((l) => l.kind === 'phone').length,
    tablets: active.filter((l) => l.kind === 'tablet').length,
    assigned: active.filter((l) => l.employee_id).length,
    shared: active.filter((l) => !l.employee_id && l.shared_label).length,
    unmatched: flagged('unmatched').length,
    spare: flagged('spare').length,
    monthlyService: sum(active, 'monthly_cost'),
    monthlyServiceKnown: known.length,
    monthlyServiceEstimated: !known.length && avg != null,
    billTotal: bill,
    monthlyInstallments: sum(active, 'monthly_installment'),
    deviceBalance: sum(active, 'device_balance'),
    cutCandidates: cut.length,
    cutMonthly: sum(cut, 'monthly_cost'),
    cutBalance: sum(cut, 'device_balance'),
    needsAttention: active.filter((l) => l.flags.some((f: LineFlag) => f.tone === 'bad' || f.tone === 'warn')).length,
    upgradeEligible: active.filter((l) => l.upgrade_eligible_now).length,
    teamsOverlap: flagged('teams_overlap').length,
    attReportAt: attAt, addigySyncedAt: getState('mobile.addigy_synced_at'), abmSyncedAt: getState('mobile.abm_synced_at'),
    byOffice,
  };
  return { lines, summary };
}

export function lineDetail(id: number): any {
  const db = getDb();
  const { lines } = listLines({ includeCancelled: true });
  const line = lines.find((l) => l.id === id);
  if (!line) return null;
  const events = db.prepare(`SELECT ev.*, e.legal_first_name, e.legal_last_name, e.preferred_name FROM mobile_line_events ev
    LEFT JOIN employees e ON e.id = ev.employee_id WHERE ev.line_id = ? ORDER BY ev.at DESC, ev.id DESC LIMIT 200`).all(id) as any[];
  return { ...line, events: events.map((ev) => ({ id: ev.id, kind: ev.kind, detail: ev.detail, actor: ev.actor, at: ev.at, employee: ev.employee_id ? `${ev.preferred_name || ev.legal_first_name || ''} ${ev.legal_last_name || ''}`.trim() : null })) };
}

/* ─────────────────────────── edits ─────────────────────────── */

export function updateLine(id: number, body: any, actor: string): any {
  const db = getDb();
  const l = db.prepare(`SELECT * FROM mobile_lines WHERE id = ?`).get(id) as any;
  if (!l) throw new Error('line not found');
  const fields: Record<string, unknown> = {};
  const changes: string[] = [];
  if (body.employee_id !== undefined) {
    const empId = body.employee_id === null || body.employee_id === '' ? null : Number(body.employee_id);
    if (empId != null && !db.prepare(`SELECT 1 FROM employees WHERE id = ?`).get(empId)) throw new Error('employee not found');
    if (empId !== l.employee_id) {
      fields.employee_id = empId;
      if (empId != null) { fields.shared_label = null; fields.holder_name = null; }
      const name = empId != null ? (db.prepare(`SELECT COALESCE(entra_display_name, COALESCE(preferred_name, legal_first_name) || ' ' || legal_last_name) n FROM employees WHERE id = ?`).get(empId) as any).n : null;
      logEvent(id, empId != null ? 'assigned' : 'unassigned', empId != null ? `Assigned to ${name}` : 'Unassigned (now a spare)', actor, empId);
      // The device in the line follows the person unless it is already on its way back.
      if (l.device_asset_id) {
        db.prepare(`UPDATE employee_assets SET employee_id = ?, status = ?, assigned_at = ? WHERE id = ? AND status IN ('assigned','available')`)
          .run(empId, empId != null ? 'assigned' : 'available', empId != null ? new Date().toISOString() : null, l.device_asset_id);
      }
      changes.push('assignment');
    }
  }
  // Only fields whose value actually changes are written and named in the history.
  const set = (col: string, value: unknown, label: string) => {
    const cur = l[col] ?? null, next = value ?? null;
    if (String(cur ?? '') === String(next ?? '')) return;
    fields[col] = next;
    changes.push(label);
  };
  if (body.shared_label !== undefined) {
    const label = clean(body.shared_label) || null;
    set('shared_label', label, 'shared label');
    if (label && l.employee_id != null && fields.employee_id === undefined) { fields.employee_id = null; fields.holder_name = null; }
  }
  if (body.monthly_cost !== undefined) {
    const c = body.monthly_cost === '' || body.monthly_cost === null ? null : Number(body.monthly_cost);
    if (c != null && !(c >= 0)) throw new Error('monthly cost must be a number');
    set('monthly_cost', c, 'monthly cost');
  }
  if (body.intent !== undefined) {
    const intent = body.intent || null;
    if (intent && !['cancel', 'freeze'].includes(intent)) throw new Error('intent must be cancel, freeze, or empty');
    if (intent !== (l.intent || null)) { fields.intent = intent; fields.intent_at = intent ? today() : null; logEvent(id, intent || 'note', intent ? `Marked to ${intent} with AT&T` : 'Cleared the pending cancel / freeze', actor); }
  }
  if (body.freeze_until !== undefined) set('freeze_until', normDate(body.freeze_until) || null, 'freeze end');
  if (body.apple_account !== undefined) {
    const a = clean(body.apple_account).toLowerCase();
    if (a && !/@/.test(a)) throw new Error('Apple account must be an email address');
    set('apple_account', a || null, 'Apple account');
  }
  if (body.notes !== undefined) set('notes', String(body.notes || '').slice(0, 4000) || null, 'notes');
  if (Object.keys(fields).length) writeLine(l.number, fields);
  if (changes.filter((c) => c !== 'assignment').length) logEvent(id, 'note', `Updated ${changes.filter((c) => c !== 'assignment').join(', ')}`, actor);
  return lineDetail(id);
}

const EVENT_KINDS = new Set(['upgrade', 'device_swap', 'freeze', 'cancel', 'reactivate', 'transfer', 'note']);
export function addLineEvent(id: number, body: any, actor: string): any {
  const kind = String(body.kind || 'note');
  if (!EVENT_KINDS.has(kind)) throw new Error('unknown event kind');
  const detail = clean(body.detail);
  if (!detail) throw new Error('add a short description');
  if (!getDb().prepare(`SELECT 1 FROM mobile_lines WHERE id = ?`).get(id)) throw new Error('line not found');
  const emp = body.employee_id ? Number(body.employee_id) : null;
  logEvent(id, kind, detail.slice(0, 1000), actor, emp);
  return lineDetail(id);
}

export function setPlanCost(planName: string, cost: unknown): void {
  const p = clean(planName);
  if (!p) throw new Error('plan is required');
  const c = cost === '' || cost === null || cost === undefined ? null : Number(cost);
  if (c != null && !(c >= 0)) throw new Error('cost must be a number');
  getDb().prepare(`INSERT INTO mobile_plan_costs (plan, monthly_cost, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(plan) DO UPDATE SET monthly_cost = excluded.monthly_cost, updated_at = excluded.updated_at`).run(p, c);
}
export function setBillTotal(amount: unknown): void {
  const v = amount === '' || amount === null || amount === undefined ? '' : Number(amount);
  if (v !== '' && !(v > 0)) throw new Error('amount must be a positive number');
  setState('mobile.monthly_bill_total', String(v));
}
export function planList(): any[] {
  const db = getDb();
  const costs = planCosts();
  const rows = db.prepare(`SELECT COALESCE(NULLIF(group_plan, ''), rate_plan) plan, COUNT(*) n FROM mobile_lines WHERE status != 'cancelled' AND COALESCE(NULLIF(group_plan, ''), rate_plan) IS NOT NULL GROUP BY 1 ORDER BY n DESC`).all() as any[];
  return rows.map((r) => ({ plan: r.plan, lines: r.n, monthly_cost: costs.get(r.plan) ?? null }));
}

/* ─────────────────────────── Teams voice audit ─────────────────────────── */

/**
 * One row per person who has an AT&T phone or a Teams voice license, with a recommendation:
 * overlap (both), unused Teams voice (licensed, no calls), or a disabled account still holding either.
 */
export function teamsAudit(): { synced: boolean; rows: any[]; counts: Record<string, number> } {
  const db = getDb();
  const synced = !!(db.prepare(`SELECT 1 FROM teams_voice_users LIMIT 1`).get());
  const { lines } = listLines();
  const phonesByEmp = new Map<number, any[]>();
  const tabletsByEmp = new Map<number, any[]>();
  for (const l of lines) {
    if (!l.employee_id || l.status !== 'active') continue;
    const m = l.kind === 'phone' ? phonesByEmp : l.kind === 'tablet' ? tabletsByEmp : null;
    if (m) m.set(l.employee_id, [...(m.get(l.employee_id) || []), l]);
  }
  const teams = db.prepare(`SELECT t.*, e.employment_status FROM teams_voice_users t LEFT JOIN employees e ON e.id = t.employee_id`).all() as any[];
  const teamsByEmp = new Map<number, any>();
  for (const t of teams) if (t.employee_id) teamsByEmp.set(t.employee_id, t);
  const people = new Set<number>([...phonesByEmp.keys(), ...teams.filter((t) => t.has_teams_phone && t.employee_id).map((t) => t.employee_id)]);
  const rows: any[] = [];
  const nameOf = (id: number) => {
    const e = db.prepare(`SELECT COALESCE(entra_display_name, COALESCE(preferred_name, legal_first_name) || ' ' || legal_last_name) n, office, employment_status FROM employees WHERE id = ?`).get(id) as any;
    return e || { n: `#${id}`, office: null, employment_status: null };
  };
  const pushRow = (name: string, office: string | null, status: string | null, phones: any[], tablets: any[], t: any) => {
    const rec = recommend(phones, t, synced);
    rows.push({
      person: name, office: office || '', employment_status: status, phones: phones.map((p) => p.number_fmt), tablets: tablets.map((p) => p.number_fmt),
      phone_cost: Math.round(phones.reduce((s, p) => s + (Number(p.monthly_cost) || 0), 0) * 100) / 100,
      phone_balance: Math.round(phones.reduce((s, p) => s + (Number(p.device_balance) || 0), 0) * 100) / 100,
      upn: t?.upn || null, account_enabled: t ? !!t.account_enabled : null, teams_phone: t ? !!t.has_teams_phone : null,
      calling_plan: t ? !!t.has_calling_plan : null, voice_plans: t?.voice_plans || '', calls: t?.call_count ?? null,
      pstn_calls: t?.pstn_calls ?? null, last_activity: t?.last_activity || null, ...rec,
    });
  };
  for (const id of people) {
    const e = nameOf(id);
    pushRow(e.n, e.office, e.employment_status, phonesByEmp.get(id) || [], tabletsByEmp.get(id) || [], teamsByEmp.get(id) || null);
  }
  // Teams voice licenses held by accounts that are not matched to an employee (shared, service or ex-staff).
  for (const t of teams) if (!t.employee_id && t.has_teams_phone) pushRow(t.display_name || t.upn, null, null, [], [], t);
  rows.sort((a, b) => a.rank - b.rank || a.person.localeCompare(b.person));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.category] = (counts[r.category] || 0) + 1;
  return { synced, rows, counts };
}

function recommend(phones: any[], t: any, synced: boolean): { category: string; recommendation: string; tone: string; rank: number } {
  const hasCell = phones.length > 0;
  if (!synced) return { category: 'pending', recommendation: 'Sync Teams voice to compare', tone: 'neutral', rank: 9 };
  if (!t) return hasCell
    ? { category: 'no_m365', recommendation: 'No Microsoft 365 account matched. Check the name, or whether this person still works here', tone: 'warn', rank: 3 }
    : { category: 'ok', recommendation: '', tone: 'neutral', rank: 9 };
  if (!t.account_enabled) return { category: 'disabled', recommendation: hasCell ? 'Microsoft 365 account is disabled but the AT&T line is active. Cancel or reassign the line' : 'Account is disabled but still holds Teams voice. Remove the license', tone: 'bad', rank: 0 };
  const pstnKnown = t.pstn_calls != null;
  const unused = t.has_teams_phone && (t.call_count ?? 0) === 0 && (!pstnKnown || t.pstn_calls === 0);
  if (unused) return { category: hasCell ? 'overlap_unused' : 'unused', recommendation: hasCell ? 'Has an AT&T phone and Teams Phone but made no Teams calls. Remove Teams Phone' : 'Teams Phone with no calls in the period. Remove the license', tone: 'bad', rank: 1 };
  if (t.has_teams_phone && hasCell) {
    const light = pstnKnown && t.pstn_calls < 10;
    return { category: 'overlap', recommendation: light ? 'Has both and barely calls real numbers on Teams. Pick one: keep the AT&T phone or Teams Phone' : 'Has both and uses Teams for calls. Candidate to drop the AT&T line (keep an iPad if it is a field tablet)', tone: 'warn', rank: 2 };
  }
  if (t.has_teams_phone) return { category: 'teams_only', recommendation: 'Teams Phone in use, no AT&T phone', tone: 'good', rank: 8 };
  return { category: 'att_only', recommendation: 'AT&T phone only, no Teams Phone', tone: 'neutral', rank: 7 };
}

/** CSV of every line for Excel, so the workbook can be retired. */
export function linesCsv(): string {
  const { lines } = listLines({ includeCancelled: true });
  const q = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['Number', 'Office', 'AT&T account', 'Kind', 'Status', 'Assigned to', 'Shared label', 'Model', 'Serial', 'IMEI', 'Plan', 'Monthly cost', 'Monthly installment', 'Device balance', 'Paid off', 'Contract end', 'Upgrade eligible', 'Last upgrade', 'Apple account', 'In Addigy', 'In ABM', 'Flags', 'Notes'];
  const body = lines.map((l) => [l.number_fmt, l.office_label, l.account, l.kind, l.intent ? `${l.status} (asked to ${l.intent})` : l.status, l.employee, l.shared_label, l.model, l.serial, l.imei, l.plan,
    l.monthly_cost, l.monthly_installment, l.device_balance, l.paid_off ? 'yes' : l.paid_off === 0 ? 'no' : '', l.contract_end, l.upgrade_eligible, l.last_upgrade_date,
    l.apple_account, l.mdm ? (l.mdm.in_addigy ? 'yes' : 'no') : '', l.mdm ? (l.mdm.in_abm ? 'yes' : 'no') : '', l.flags.map((f: LineFlag) => f.label).join('; '), l.notes].map(q).join(','));
  return [head.join(','), ...body].join('\n');
}
