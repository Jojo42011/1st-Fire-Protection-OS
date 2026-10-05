import { getDb } from '../db/index';
import { catalogByKind, catalogAll, CatalogItem } from './onboardingCatalog';
import { addUserToGroup, graphConfigured } from './msGraphGroups';
import { managerEmailByName, managerOfByName } from './offboardingAgent';

/**
 * New-hire Onboarding engine.
 *
 * One intake form captures every onboarding field for a new employee. createRequest() stores
 * the request, then runs the routing map below to fan the SET/CHECKED fields out into
 * onboarding_items - each addressed to the right owner as a task (do it) or an approval (a
 * human must say yes). This is a self-contained internal workflow: nothing here calls an
 * external system. The BambooHR items are routed tasks a person acts on (a future push can
 * reuse services/bamboo.ts, but nothing writes to Bamboo here), and every approval is an
 * explicit human click - nothing auto-approves. A request completes when no item is still
 * pending.
 */

/* ─────────────────────────── the owners (the color key) ─────────────────────────── */
// 'mario' (Owner) and 'daniel' (Ops) are legacy lanes kept only so old decided items still read
// correctly: IT now approves workstations and licensed software, and Safety takes vehicle details.
export type Owner = 'bamboo' | 'it' | 'it_manager' | 'manager' | 'mario' | 'rebecca' | 'sandi' | 'denise' | 'daniel' | 'laura';

/** Display label + the tag shown on the form, per owner. Order is the grouped-view order. */
export const OWNERS: { key: Owner; label: string; tag: string }[] = [
  { key: 'bamboo', label: '(HR builds it)', tag: 'BambooHR' },
  { key: 'it', label: 'IT (provisioning)', tag: 'IT' },
  { key: 'it_manager', label: 'IT manager (approval)', tag: 'IT Manager' },
  { key: 'manager', label: 'Approving manager (one level up)', tag: 'Manager' },
  { key: 'rebecca', label: 'Accounting (approval)', tag: 'Accounting' },
  { key: 'sandi', label: 'HR (approval)', tag: 'HR' },
  { key: 'denise', label: 'Safety (approval)', tag: 'Safety' },
  { key: 'laura', label: 'ServiceTrade (provisioning)', tag: 'ServiceTrade' },
];
const OWNER_LABEL: Record<Owner, string> = OWNERS.reduce(
  (m, o) => ((m[o.key] = o.label), m),
  { mario: 'Owner (approval)', daniel: 'Ops (approval)' } as Record<Owner, string>
);
const OWNER_ORDER: Owner[] = OWNERS.map((o) => o.key);

/* ─────────────────────────── the option catalogs ───────────────────────────
 * Software, SharePoint groups, printers and computers are no longer hardcoded: they live in the
 * editable onboarding_catalog table (a People admin maintains the real company list), and the
 * routing for each selection (owner team, and whether it needs an approval) is read from the same
 * rows. See services/onboardingCatalog.ts. */

/** Look up the routing for one selected catalog item (by kind + name). */
function catalogRoute(kind: 'software' | 'sharepoint' | 'sage' | 'servicetrade', name: string): { owner: Owner; kind: 'task' | 'approval'; price: number | null } | undefined {
  const item = catalogByKind(kind).find((c) => c.name === name);
  if (!item) return undefined;
  return { owner: item.owner as Owner, kind: item.approval ? 'approval' : 'task', price: item.price ?? null };
}

/** Computers are chosen by purchase tier (the form submits the tier key as computer_type). Prices
 *  match the asset-library cost model. Exported so the intake routes offer the same set. */
export const COMPUTER_TIERS: Record<string, { key: string; label: string; spec: string; price: number }> = {
  standard: { key: 'standard', label: 'Standard laptop', spec: 'General office use · 16 GB', price: 1000 },
  business: { key: 'business', label: 'Business laptop', spec: 'Heavier multitasking · 32 GB', price: 1400 },
  cad: { key: 'cad', label: 'CAD workstation', spec: 'HydraCAD / AutoCAD · 32 GB · 8 GB GPU', price: 2000 },
};
export const DOCK_PRICE = 200;
export function computerTierList(): { key: string; label: string; spec: string; price: number }[] {
  return Object.keys(COMPUTER_TIERS).map((k) => COMPUTER_TIERS[k]);
}
function computerById(idLike: string): { label: string; spec: string | null } | undefined {
  const t = COMPUTER_TIERS[String(idLike)];
  if (t) return { label: t.label, spec: `${t.spec} · $${t.price.toLocaleString()}` };
  // Back-compat: an older request may still carry a numeric catalog id.
  const id = Number(idLike);
  if (!Number.isFinite(id)) return undefined;
  const item = catalogByKind('computer').find((c) => c.id === id);
  return item ? { label: item.name, spec: item.spec } : undefined;
}

/** The pay/HR exceptions that each route to a BambooHR task when checked. */
const PAY_EXCEPTIONS: { field: string; label: string }[] = [
  { field: 'cell_reimburse', label: 'Cell-phone reimbursement' },
  { field: 'pto_plan', label: 'Different PTO plan' },
  { field: 'hours_80_40', label: '80-vs-40 hours approved' },
  { field: 'probation_waived', label: '60-day probation waived' },
  { field: 'incentive_plan', label: 'Incentive plan' },
  { field: 'vehicle_allowance', label: 'Vehicle allowance (Sandi builds into pay)' },
];

/* ─────────────────────────── types ─────────────────────────── */
export interface OnboardingPayload {
  name: string;
  employee_id?: number; // set when the intake is bound to a confirmed BambooHR hire
  personal_email?: string;
  start_date?: string;
  cell_phone?: string;
  job_position?: string;
  salary?: string;
  manager_name?: string;
  company_email?: boolean;
  teams_number?: boolean;
  cell_reimburse?: boolean;
  pto_plan?: boolean;
  hours_80_40?: boolean;
  probation_waived?: boolean;
  incentive_plan?: boolean;
  vehicle_allowance?: boolean;
  misc_exceptions?: string;
  company_cell?: boolean;
  ipad?: boolean;
  company_vehicle?: boolean;
  vehicle_details?: string;
  vehicle_transfer?: boolean;
  wex_card?: boolean;
  computer_type?: string; // none|standard|business|cad
  dock?: boolean; // docking station accessory
  software?: string[];
  sharepoint?: string[];
  printers?: string[];
  sage?: string;              // selected Sage role
  servicetrade?: string;      // selected ServiceTrade role
  existing_computer?: string; // name or asset tag of a computer being transferred to this hire
}

export interface OnboardingItem {
  id: number;
  request_id: number;
  email_to?: string | null;
  due_at?: string | null;
  parent_id?: number | null;
  note?: string | null;
  owner: Owner;
  owner_label: string;
  kind: 'task' | 'approval';
  label: string;
  detail: string | null;
  status: 'pending' | 'done' | 'approved' | 'rejected';
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

interface DraftItem {
  owner: Owner;
  kind: 'task' | 'approval';
  label: string;
  detail?: string;
  email_to?: string;
}

/** The hire's manager, from BambooHR: the bound employee's supervisor, else the manager named on the
 *  intake, matched to a work email on the roster. */
export function resolveHireManager(req: { employee_id?: number | null; manager_name?: string | null }): { name: string | null; email: string | null; source: 'bamboo' | 'intake' | null } {
  const db = getDb();
  if (req.employee_id) {
    const e = db.prepare(`SELECT manager FROM employees WHERE id = ?`).get(req.employee_id) as { manager: string | null } | undefined;
    if (e?.manager) {
      const email = managerEmailByName(e.manager);
      if (email) return { name: e.manager, email, source: 'bamboo' };
    }
  }
  const named = String(req.manager_name || '').trim();
  if (named) {
    const email = managerEmailByName(named);
    if (email) return { name: named, email, source: 'intake' };
  }
  return { name: named || null, email: null, source: null };
}

/**
 * Who approves a new computer: the hire's manager's own manager (one level up in BambooHR), since the
 * hire's manager is usually the one who filled in the intake form. Falls back to the IT manager when
 * BambooHR has no supervisor (or no email) above the hire's manager, so it is never stranded.
 */
export function resolveComputerApprover(req: { employee_id?: number | null; manager_name?: string | null }): { name: string | null; email: string | null; via: string | null } {
  const m = resolveHireManager(req);
  if (!m.name) return { name: null, email: null, via: null };
  const up = managerOfByName(m.name);
  const email = up ? managerEmailByName(up) : null;
  if (!up || !email || (m.email && email.toLowerCase() === m.email.toLowerCase())) return { name: up, email: null, via: m.name };
  return { name: up, email, via: m.name };
}

function computerApprovalRoute(req: any): { owner: Owner; email_to?: string; note: string } {
  const a = resolveComputerApprover(req);
  if (a.email) return { owner: 'manager', email_to: a.email, note: `Approver: ${a.name} (${a.via}'s manager, from BambooHR)` };
  return { owner: 'it_manager', note: a.via ? `No manager above ${a.via} found in BambooHR, so this came to the IT manager.` : 'No manager found for this hire, so this came to the IT manager.' };
}

/** Drop routing notes an earlier route appended to an approval's detail, before adding the current one. */
function stripRouteNote(detail: string | null): string | null {
  const keep = String(detail || '').split(/\.\s+/).filter((seg) => seg && !/^(Manager: |Approver: |No manager (email )?(found|above))/.test(seg.trim()));
  return keep.length ? keep.join('. ').replace(/\.$/, '') : null;
}

const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'on';

/* ─────────────────────────── due dates (from the hire's start date) ───────────────────────────
 * Approvals are due a week of business days before the start (so the follow-up work has time);
 * tasks are due the business day before. Never earlier than today, so a late request is "due today"
 * rather than born overdue. No start date, no due date. */
const APPROVAL_LEAD_DAYS = 5;
const TASK_LEAD_DAYS = 1;

function todayCentral(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function minusBusinessDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
export function dueFor(kind: 'task' | 'approval', startDate: string | null | undefined, now = new Date()): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(startDate || ''));
  if (!m) return null;
  const due = minusBusinessDays(m[1], kind === 'approval' ? APPROVAL_LEAD_DAYS : TASK_LEAD_DAYS);
  const today = todayCentral(now);
  return due < today ? today : due;
}

/* ─────────────────────────── the routing map ───────────────────────────
 * Given the stored request, produce the list of items. A field only generates an item when
 * it is set/checked, so a sparse form makes a short, clean queue. */
function routeItems(req: any): DraftItem[] {
  const items: DraftItem[] = [];

  // ── BambooHR: the new-hire record is always ONE task ──
  const recordDetail = [
    req.name && `Name: ${req.name}`,
    req.personal_email && `Personal email: ${req.personal_email}`,
    req.start_date && `Start date: ${req.start_date}`,
    req.cell_phone && `Cell phone: ${req.cell_phone}`,
    req.job_position && `Position: ${req.job_position}`,
    req.salary && `Salary: ${req.salary}`,
    req.manager_name && `Manager: ${req.manager_name}`,
  ]
    .filter(Boolean)
    .join(' · ');
  items.push({
    owner: 'bamboo',
    kind: 'task',
    label: 'Create employee in BambooHR (Sandi)',
    detail: recordDetail,
  });

  // ── BambooHR: one task per set pay/HR exception ──
  for (const ex of PAY_EXCEPTIONS) {
    if (bool(req[ex.field])) items.push({ owner: 'bamboo', kind: 'task', label: ex.label });
  }
  const misc = (req.misc_exceptions || '').trim();
  if (misc) items.push({ owner: 'bamboo', kind: 'task', label: 'Misc pay/HR exception', detail: misc });

  // ── IT: email + Teams number ──
  if (bool(req.company_email)) items.push({ owner: 'it', kind: 'task', label: 'Set up company email' });
  if (bool(req.teams_number)) items.push({ owner: 'it', kind: 'task', label: 'Set up Teams number' });

  // ── software (IT for standard, Mario approval for premium) ──
  const software: string[] = safeArray(req.software_json);
  for (const name of software) {
    const s = catalogRoute('software', name);
    if (!s) continue;
    if (s.kind === 'approval')
      items.push({ owner: s.owner, kind: 'approval', label: `Approve ${name} license`, detail: 'Licensed software: needs IT sign-off before the seat is bought or assigned.' });
    else items.push({ owner: s.owner, kind: 'task', label: `Install ${name}` });
  }

  // ── SharePoint groups (IT, or Mario/Rebecca/Sandi approval per group) ──
  const groups: string[] = safeArray(req.sharepoint_json);
  for (const name of groups) {
    const g = catalogRoute('sharepoint', name);
    if (!g) continue;
    if (g.kind === 'approval')
      items.push({ owner: g.owner, kind: 'approval', label: `Approve SharePoint group: ${name}`, detail: 'Restricted group - needs approval before access.' });
    else items.push({ owner: g.owner, kind: 'task', label: `Add to SharePoint group: ${name}` });
  }

  // ── Sage access (Accounting / Rebecca approves the seat + cost) ──
  if (req.sage) {
    const s = catalogRoute('sage', String(req.sage));
    if (s) {
      const priceStr = s.price != null ? ` ($${Number(s.price).toLocaleString(undefined, { minimumFractionDigits: 2 })})` : '';
      items.push({ owner: s.owner, kind: s.kind, label: `${s.kind === 'approval' ? 'Approve' : 'Grant'} Sage access: ${req.sage}${priceStr}`, detail: 'Sage seat - provisioned by Accounting.' });
    }
  }

  // ── ServiceTrade access (Laura provisions) ──
  if (req.servicetrade) {
    const t = catalogRoute('servicetrade', String(req.servicetrade));
    if (t) items.push({ owner: t.owner, kind: t.kind, label: `Grant ServiceTrade access: ${req.servicetrade}` });
  }

  // ── existing computer: IT task to set up the transferred machine for the new hire ──
  if (req.existing_computer && String(req.existing_computer).trim()) {
    items.push({ owner: 'it', kind: 'task', label: `Set up existing computer for ${req.name}: ${String(req.existing_computer).trim()}`, detail: 'Wipe or re-profile the existing machine, add to the hire\'s AD account, verify encryption and updates.' });
  }

  // ── printers -> per-office Entra security group (IT). Selecting an office's printers adds the hire
  //    to its SG-PR-<office> group; the item carries the group so IT (or auto-provisioning) can act. ──
  const printers: string[] = safeArray(req.printers_json);
  const printerCatalog = catalogByKind('printer');
  for (const name of printers) {
    const p = printerCatalog.find((c) => c.name === name);
    if (p && p.group_name) {
      items.push({
        owner: 'it',
        kind: 'task',
        label: `Add to security group: ${p.group_name}`,
        detail: `${name} printers. Entra group ${p.group_name}${p.group_id ? ` (${p.group_id})` : ''}.`,
      });
    } else {
      items.push({ owner: 'it', kind: 'task', label: `Connect printer: ${name}`, detail: p && !p.group_name ? `No Entra group set for ${name} yet.` : undefined });
    }
  }

  // ── new computer: the hire's manager approves the purchase (IT manager if none is on file);
  //    approving creates IT's order + setup task ──
  const ct = (req.computer_type || 'none') as string;
  if (ct && ct !== 'none') {
    const comp = computerById(ct);
    if (comp) {
      const detail = [comp.label, comp.spec].filter(Boolean).join(': ');
      const route = computerApprovalRoute(req);
      items.push({ owner: route.owner, kind: 'approval', label: 'Approve new computer', detail: [detail, route.note].filter(Boolean).join('. '), email_to: route.email_to });
    }
  }

  // ── IT: docking station (a computer accessory) ──
  if (bool(req.dock)) items.push({ owner: 'it', kind: 'task', label: 'Provide docking station', detail: `$${DOCK_PRICE}` });

  // ── IT: company devices (cell phone + iPad are provisioned by IT) ──
  if (bool(req.company_cell)) items.push({ owner: 'it', kind: 'task', label: 'Issue company cell phone' });
  if (bool(req.ipad)) items.push({ owner: 'it', kind: 'task', label: 'Issue company iPad' });
  // ── Safety (Denise): fleet/vehicle equipment ──
  if (bool(req.vehicle_transfer)) items.push({ owner: 'denise', kind: 'task', label: 'Company vehicle transfer' });
  if (bool(req.wex_card)) items.push({ owner: 'denise', kind: 'task', label: 'Issue WEX fuel card' });

  // ── company vehicle needed -> HR runs the MVR, Safety adds them to the policy (with the vehicle details) ──
  if (bool(req.company_vehicle)) {
    const vd = (req.vehicle_details || '').trim();
    items.push({ owner: 'sandi', kind: 'task', label: "Send driver's license to Denise + run motor vehicle report" });
    items.push({ owner: 'denise', kind: 'task', label: 'Add to State Auto Policy (after the MVR clears)', detail: vd ? `Vehicle: ${vd}` : undefined });
  }

  return items;
}

function safeArray(json: unknown): string[] {
  if (Array.isArray(json)) return json as string[];
  if (typeof json !== 'string' || !json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/* ─────────────────────────── create / read ─────────────────────────── */

/** Insert the request, route it into items, return the request + its items. */
export function createRequest(payload: OnboardingPayload): { request: any; items: OnboardingItem[] } {
  const db = getDb();
  if (!payload || !payload.name || !String(payload.name).trim()) throw new Error('name is required');

  const info = db
    .prepare(
      `INSERT INTO onboarding_requests
        (name, employee_id, personal_email, start_date, cell_phone, job_position, salary, manager_name,
         company_email, teams_number, cell_reimburse, pto_plan, hours_80_40, probation_waived,
         incentive_plan, vehicle_allowance, misc_exceptions, company_cell, ipad, company_vehicle,
         vehicle_details, vehicle_transfer, wex_card, computer_type, dock, software_json, sharepoint_json, printers_json, sage, servicetrade, existing_computer)
       VALUES
        (@name, @employee_id, @personal_email, @start_date, @cell_phone, @job_position, @salary, @manager_name,
         @company_email, @teams_number, @cell_reimburse, @pto_plan, @hours_80_40, @probation_waived,
         @incentive_plan, @vehicle_allowance, @misc_exceptions, @company_cell, @ipad, @company_vehicle,
         @vehicle_details, @vehicle_transfer, @wex_card, @computer_type, @dock, @software_json, @sharepoint_json, @printers_json, @sage, @servicetrade, @existing_computer)`
    )
    .run({
      name: String(payload.name).trim(),
      employee_id: payload.employee_id || null,
      personal_email: payload.personal_email || null,
      start_date: payload.start_date || null,
      cell_phone: payload.cell_phone || null,
      job_position: payload.job_position || null,
      salary: payload.salary || null,
      manager_name: payload.manager_name || null,
      company_email: bool(payload.company_email) ? 1 : 0,
      teams_number: bool(payload.teams_number) ? 1 : 0,
      cell_reimburse: bool(payload.cell_reimburse) ? 1 : 0,
      pto_plan: bool(payload.pto_plan) ? 1 : 0,
      hours_80_40: bool(payload.hours_80_40) ? 1 : 0,
      probation_waived: bool(payload.probation_waived) ? 1 : 0,
      incentive_plan: bool(payload.incentive_plan) ? 1 : 0,
      vehicle_allowance: bool(payload.vehicle_allowance) ? 1 : 0,
      misc_exceptions: (payload.misc_exceptions || '').trim() || null,
      company_cell: bool(payload.company_cell) ? 1 : 0,
      ipad: bool(payload.ipad) ? 1 : 0,
      company_vehicle: bool(payload.company_vehicle) ? 1 : 0,
      vehicle_details: (payload.vehicle_details || '').trim() || null,
      vehicle_transfer: bool(payload.vehicle_transfer) ? 1 : 0,
      wex_card: bool(payload.wex_card) ? 1 : 0,
      computer_type: payload.computer_type || 'none',
      dock: bool(payload.dock) ? 1 : 0,
      software_json: JSON.stringify(Array.isArray(payload.software) ? payload.software : []),
      sharepoint_json: JSON.stringify(Array.isArray(payload.sharepoint) ? payload.sharepoint : []),
      printers_json: JSON.stringify(Array.isArray(payload.printers) ? payload.printers : []),
      sage: (payload.sage || '').trim() || null,
      servicetrade: (payload.servicetrade || '').trim() || null,
      existing_computer: (payload.existing_computer || '').trim() || null,
    });

  const requestId = Number(info.lastInsertRowid);
  const req = db.prepare(`SELECT * FROM onboarding_requests WHERE id = ?`).get(requestId);

  const drafts = routeItems(req);
  const insItem = db.prepare(
    `INSERT INTO onboarding_items (request_id, owner, owner_label, kind, label, detail, due_at, email_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const startDate = (req as any).start_date as string | null;
  for (const d of drafts) insItem.run(requestId, d.owner, OWNER_LABEL[d.owner], d.kind, d.label, d.detail || null, dueFor(d.kind, startDate), d.email_to || null);

  return { request: req, items: itemsFor(requestId) };
}

/* ─────────────────────────── one-click provisioning (Microsoft Graph) ───────────────────────────
 * Execute the access-group items IT would otherwise click one by one: for each pending group item
 * that resolves to an Entra group, add the hire to that group via Graph and mark the item done.
 * Keyless-safe (a no-op with a reason when Graph is not connected), and it only touches items that
 * carry a real group id; approvals, hardware and pay tasks are left for a human. */

/** Resolve the Entra group an "Add to ..." item targets, from the editable catalog. */
function itemGroup(label: string, printers: CatalogItem[], groups: CatalogItem[]): { id: string | null; name: string } | null {
  let m = /^Add to security group:\s*(.+)$/.exec(label);
  if (m) {
    const name = m[1].trim();
    const g = printers.find((p) => p.group_name === name);
    return { id: g ? g.group_id : null, name: g ? g.group_name || name : name };
  }
  m = /^Add to SharePoint group:\s*(.+)$/.exec(label);
  if (m) {
    const name = m[1].trim();
    const g = groups.find((x) => x.name === name);
    return { id: g ? g.group_id : null, name: g ? g.group_name || name : name };
  }
  return null;
}

export async function provisionRequestGroups(
  requestId: number,
  actor: string,
): Promise<{ ok: boolean; error?: string; results: { item_id: number; group: string; ok: boolean; error?: string }[]; done: number; skipped: number }> {
  const db = getDb();
  const request = db.prepare(`SELECT * FROM onboarding_requests WHERE id = ?`).get(requestId) as any;
  if (!request) return { ok: false, error: 'request not found', results: [], done: 0, skipped: 0 };
  if (!graphConfigured()) return { ok: false, error: 'Microsoft Graph is not connected, so groups cannot be auto-provisioned. Set the Entra app credentials to enable this.', results: [], done: 0, skipped: 0 };

  let upn: string | null = null;
  if (request.employee_id) {
    const e = db.prepare(`SELECT work_email FROM employees WHERE id = ?`).get(request.employee_id) as { work_email: string | null } | undefined;
    upn = (e && e.work_email) || null;
  }
  if (!upn) return { ok: false, error: 'No Microsoft work email on file for this hire yet. Create their M365 account first, then provision groups.', results: [], done: 0, skipped: 0 };

  const items = db.prepare(`SELECT * FROM onboarding_items WHERE request_id = ? AND owner = 'it' AND kind = 'task' AND status = 'pending'`).all(requestId) as OnboardingItem[];
  const printers = catalogByKind('printer');
  const groups = catalogByKind('sharepoint');
  const results: { item_id: number; group: string; ok: boolean; error?: string }[] = [];
  let done = 0, skipped = 0;
  for (const it of items) {
    const target = itemGroup(it.label, printers, groups);
    if (!target || !target.id) { skipped++; continue; } // not a group item, or no Entra id mapped yet
    // eslint-disable-next-line no-await-in-loop
    const out = await addUserToGroup(upn, { groupId: target.id, groupName: target.name });
    results.push({ item_id: it.id, group: target.name, ok: out.ok, error: out.error });
    if (out.ok) {
      db.prepare(`UPDATE onboarding_items SET status = 'done', decided_by = ?, decided_at = datetime('now') WHERE id = ?`).run(actor, it.id);
      done++;
    }
  }
  return { ok: true, results, done, skipped };
}

/** Apply a completed ad_create_user DC job back to the onboarding request: mark the account and
 *  security-group items done and stamp the hire's AD identity. Called when the agent reports success. */
export function applyCreateUserResult(requestId: number, result: { sam?: string; upn?: string; objectGuid?: string; groupsAdded?: string[] }): void {
  const db = getDb();
  const req = db.prepare(`SELECT * FROM onboarding_requests WHERE id = ?`).get(requestId) as any;
  if (!req) return;
  const items = db.prepare(`SELECT id, label FROM onboarding_items WHERE request_id = ? AND owner = 'it' AND kind = 'task' AND status = 'pending'`).all(requestId) as { id: number; label: string }[];
  const markDone = db.prepare(`UPDATE onboarding_items SET status = 'done', decided_by = 'dc-agent', decided_at = datetime('now') WHERE id = ?`);
  for (const it of items) {
    if (/^Add to security group:/.test(it.label) || it.label === 'Set up company email') markDone.run(it.id);
  }
  if (req.employee_id && (result.sam || result.upn)) {
    db.prepare(`UPDATE employees SET ad_username = COALESCE(?, ad_username), upn = COALESCE(?, upn), updated_at = datetime('now') WHERE id = ?`)
      .run(result.sam || null, result.upn || null, req.employee_id);
  }
  recomputeRequestStatus(requestId);
}

/** All items for a request, ordered by the owner display order then id. */
function itemsFor(requestId: number): OnboardingItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM onboarding_items WHERE request_id = ? ORDER BY id ASC`)
    .all(requestId) as OnboardingItem[];
  return rows;
}

export interface OwnerGroup {
  owner: Owner | string;
  owner_label: string;
  items: OnboardingItem[];
  pending: number;
}

/** A request plus its items grouped by owner (in the owner display order). */
export function getRequest(id: number): {
  request: any;
  groups: OwnerGroup[];
  rollup: RequestRollup;
} | null {
  const db = getDb();
  const request = db.prepare(`SELECT * FROM onboarding_requests WHERE id = ?`).get(id);
  if (!request) return null;
  const items = itemsFor(id);

  const byOwner = new Map<string, OnboardingItem[]>();
  for (const it of items) {
    if (!byOwner.has(it.owner)) byOwner.set(it.owner, []);
    byOwner.get(it.owner)!.push(it);
  }
  const orderedKeys = [
    ...OWNER_ORDER.filter((k) => byOwner.has(k)),
    ...[...byOwner.keys()].filter((k) => !OWNER_ORDER.includes(k as Owner)),
  ];
  const groups: OwnerGroup[] = orderedKeys.map((k) => {
    const list = byOwner.get(k)!;
    return {
      owner: k,
      owner_label: OWNER_LABEL[k as Owner] || list[0].owner_label,
      items: list,
      pending: list.filter((i) => i.status === 'pending').length,
    };
  });

  return { request, groups, rollup: rollupFor(items) };
}

export interface RequestRollup {
  total: number;
  settled: number; // done + approved + rejected
  done: number;
  pending: number;
  pendingApprovals: number;
  progress: number; // 0..100, (done+approved) / total
}

function rollupFor(items: OnboardingItem[]): RequestRollup {
  const total = items.length;
  const done = items.filter((i) => i.status === 'done' || i.status === 'approved').length;
  const settled = items.filter((i) => i.status !== 'pending').length;
  const pending = total - settled;
  const pendingApprovals = items.filter((i) => i.kind === 'approval' && i.status === 'pending').length;
  return {
    total,
    settled,
    done,
    pending,
    pendingApprovals,
    progress: total ? Math.round((done / total) * 100) : 0,
  };
}

/** Every request with a progress rollup, newest first (the board). Discarded requests are hidden. */
export function listRequests(): (any & { rollup: RequestRollup })[] {
  const db = getDb();
  const requests = db.prepare(`SELECT * FROM onboarding_requests WHERE status IS NULL OR status != 'discarded' ORDER BY id DESC`).all() as any[];
  return requests.map((r) => ({ ...r, rollup: rollupFor(itemsFor(r.id)) }));
}

/** Discard an onboarding request: mark it discarded so it drops off the board. Reversible (the row and
 *  its items are kept); use for test entries or a hire who never actually started. */
export function discardRequest(id: number, _actor: string): boolean {
  const db = getDb();
  const r = db.prepare(`UPDATE onboarding_requests SET status = 'discarded' WHERE id = ? AND (status IS NULL OR status != 'discarded')`).run(id);
  return r.changes > 0;
}

/* ─────────────────────────── decisions (the human gate) ─────────────────────────── */

function decide(id: number, next: 'done' | 'approved' | 'rejected', requireKind: 'task' | 'approval', by: string) {
  const db = getDb();
  const item = db.prepare(`SELECT * FROM onboarding_items WHERE id = ?`).get(id) as OnboardingItem | undefined;
  if (!item) throw new Error(`item ${id} not found`);
  if (item.kind !== requireKind)
    throw new Error(`item ${id} is a ${item.kind}, not a ${requireKind}`);
  if (item.status === 'pending') {
    db.prepare(
      `UPDATE onboarding_items SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`
    ).run(next, by || 'operator', id);
  }
  recomputeRequestStatus(item.request_id);
  return db.prepare(`SELECT * FROM onboarding_items WHERE id = ?`).get(id) as OnboardingItem;
}

/** Complete a task (task -> done). */
export function completeItem(id: number, by = 'operator'): OnboardingItem {
  return decide(id, 'done', 'task', by);
}

/** The work an approval unlocks: approving a purchase or access is not the same as delivering it. */
export function followUpFor(approval: { label: string; detail: string | null; owner: string }, hireName: string): DraftItem | null {
  let m: RegExpExecArray | null;
  if (approval.label === 'Approve new computer') {
    return { owner: 'it', kind: 'task', label: `Order and set up new computer for ${hireName}`, detail: [approval.detail, 'Order it, image it, encrypt it, install the standard apps, and have it ready on day one.'].filter(Boolean).join('. ') };
  }
  if ((m = /^Approve (.+) license$/.exec(approval.label))) return { owner: 'it', kind: 'task', label: `Install ${m[1]}`, detail: 'License approved: buy or assign the seat, then install.' };
  if ((m = /^Approve SharePoint group:\s*(.+)$/.exec(approval.label))) return { owner: 'it', kind: 'task', label: `Add to SharePoint group: ${m[1].trim()}`, detail: 'Access approved.' };
  if ((m = /^Approve Sage access:\s*(.+)$/.exec(approval.label))) return { owner: approval.owner as Owner, kind: 'task', label: `Set up Sage access: ${m[1].replace(/\s*\(\$[^)]*\)\s*$/, '').trim()}`, detail: 'Seat approved: create the Sage user.' };
  if ((m = /^Grant ServiceTrade access:\s*(.+)$/.exec(approval.label))) return { owner: 'laura', kind: 'task', label: `Set up ServiceTrade access: ${m[1].trim()}` };
  return null;
}

/** Approve an approval (the human gate; approval -> approved), then create the task that delivers it.
 *  Idempotent: a follow-up is only created once per approval. */
export function approveItem(id: number, by = 'operator'): OnboardingItem & { followUp?: OnboardingItem | null } {
  const item = decide(id, 'approved', 'approval', by);
  const db = getDb();
  const req = db.prepare(`SELECT name, start_date FROM onboarding_requests WHERE id = ?`).get(item.request_id) as { name: string; start_date: string | null } | undefined;
  const existing = db.prepare(`SELECT * FROM onboarding_items WHERE parent_id = ?`).get(id) as OnboardingItem | undefined;
  if (existing || item.status !== 'approved' || !req) return { ...item, followUp: existing || null };
  const f = followUpFor(item, req.name);
  if (!f) return { ...item, followUp: null };
  const r = db.prepare(
    `INSERT INTO onboarding_items (request_id, owner, owner_label, kind, label, detail, due_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(item.request_id, f.owner, OWNER_LABEL[f.owner] || f.owner, f.kind, f.label, f.detail || null, dueFor('task', req.start_date), id);
  recomputeRequestStatus(item.request_id);
  const followUp = db.prepare(`SELECT * FROM onboarding_items WHERE id = ?`).get(Number(r.lastInsertRowid)) as OnboardingItem;
  return { ...(db.prepare(`SELECT * FROM onboarding_items WHERE id = ?`).get(id) as OnboardingItem), followUp };
}

/** Reject an approval (the human gate; approval -> rejected), keeping the reason when one is given. */
export function rejectItem(id: number, by = 'operator', reason?: string | null): OnboardingItem {
  const item = decide(id, 'rejected', 'approval', by);
  const note = String(reason || '').trim().slice(0, 500);
  if (note && item.status === 'rejected') {
    getDb().prepare(`UPDATE onboarding_items SET note = ? WHERE id = ? AND note IS NULL`).run(note, id);
  }
  return getDb().prepare(`SELECT * FROM onboarding_items WHERE id = ?`).get(id) as OnboardingItem;
}

/** A request is 'complete' once nothing is pending, unless something was rejected: then it needs a
 *  person to sort it out with the manager ('needs_attention'), not a green "complete". */
function recomputeRequestStatus(requestId: number): void {
  const db = getDb();
  const cur = db.prepare(`SELECT status FROM onboarding_requests WHERE id = ?`).get(requestId) as { status: string | null } | undefined;
  if (cur && cur.status === 'discarded') return;
  const c = db
    .prepare(`SELECT SUM(status = 'pending') AS pending, SUM(status = 'rejected') AS rejected FROM onboarding_items WHERE request_id = ?`)
    .get(requestId) as { pending: number | null; rejected: number | null };
  const status = (c.pending || 0) > 0 ? 'open' : (c.rejected || 0) > 0 ? 'needs_attention' : 'complete';
  db.prepare(`UPDATE onboarding_requests SET status = ? WHERE id = ?`).run(status, requestId);
}

/** Move a hire's start date: re-date every pending item. Returns the request (or null if missing). */
export function setStartDate(requestId: number, startDate: string | null, now = new Date()): any | null {
  const db = getDb();
  const req = db.prepare(`SELECT * FROM onboarding_requests WHERE id = ?`).get(requestId) as any;
  if (!req) return null;
  const v = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : null;
  db.prepare(`UPDATE onboarding_requests SET start_date = ? WHERE id = ?`).run(v, requestId);
  // The BambooHR record task carries the date in its text; keep it in step.
  if (req.start_date && v && req.start_date !== v) {
    db.prepare(`UPDATE onboarding_items SET detail = replace(detail, ?, ?) WHERE request_id = ? AND status = 'pending' AND detail LIKE ?`)
      .run(`Start date: ${req.start_date}`, `Start date: ${v}`, requestId, `%Start date: ${req.start_date}%`);
  }
  const pending = db.prepare(`SELECT id, kind FROM onboarding_items WHERE request_id = ? AND status = 'pending'`).all(requestId) as { id: number; kind: 'task' | 'approval' }[];
  const upd = db.prepare(`UPDATE onboarding_items SET due_at = ? WHERE id = ?`);
  for (const it of pending) upd.run(dueFor(it.kind, v, now), it.id);
  return db.prepare(`SELECT * FROM onboarding_requests WHERE id = ?`).get(requestId);
}

/** Open "Approve new computer" items made before manager routing: send each to the hire's manager.
 *  Once (a state flag), at boot. Returns how many moved. */
export function rerouteComputerApprovalsToManagers(): number {
  const { getState, setState } = require('../db/schema') as typeof import('../db/schema');
  if (getState('onboarding_computer_to_skip_level_v1') === '1') return 0;
  const db = getDb();
  const rows = db.prepare(
    `SELECT i.id, i.detail, r.employee_id, r.manager_name FROM onboarding_items i JOIN onboarding_requests r ON r.id = i.request_id
      WHERE i.status = 'pending' AND i.label = 'Approve new computer' AND i.owner IN ('it', 'it_manager', 'mario', 'manager')`
  ).all() as { id: number; detail: string | null; employee_id: number | null; manager_name: string | null }[];
  const upd = db.prepare(`UPDATE onboarding_items SET owner = ?, owner_label = ?, email_to = ?, detail = ? WHERE id = ?`);
  let moved = 0;
  for (const r of rows) {
    const route = computerApprovalRoute(r);
    upd.run(route.owner, OWNER_LABEL[route.owner], route.email_to || null, [stripRouteNote(r.detail), route.note].filter(Boolean).join('. '), r.id);
    moved++;
  }
  setState('onboarding_computer_to_skip_level_v1', '1');
  return moved;
}

/** Give pending items on open requests a due date when they have none yet (requests made before due
 *  dates existed). Idempotent; runs at boot. */
export function backfillDueDates(now = new Date()): number {
  const db = getDb();
  const rows = db.prepare(
    `SELECT i.id, i.kind, r.start_date FROM onboarding_items i JOIN onboarding_requests r ON r.id = i.request_id
      WHERE i.status = 'pending' AND i.due_at IS NULL AND r.start_date IS NOT NULL AND (r.status = 'open' OR r.status IS NULL)`
  ).all() as { id: number; kind: 'task' | 'approval'; start_date: string }[];
  const upd = db.prepare(`UPDATE onboarding_items SET due_at = ? WHERE id = ?`);
  let n = 0;
  for (const r of rows) { const d = dueFor(r.kind, r.start_date, now); if (d) { upd.run(d, r.id); n++; } }
  return n;
}

/** Open requests whose BambooHR start date changed since the intake: returns the ones it re-dated. */
export function syncStartDatesFromEmployees(now = new Date()): { id: number; name: string; from: string | null; to: string }[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT r.id, r.name, r.start_date, COALESCE(e.actual_start_date, e.anticipated_start_date) AS emp_start
       FROM onboarding_requests r JOIN employees e ON e.id = r.employee_id
      WHERE r.status = 'open' OR r.status IS NULL`
  ).all() as { id: number; name: string; start_date: string | null; emp_start: string | null }[];
  const changed: { id: number; name: string; from: string | null; to: string }[] = [];
  for (const r of rows) {
    const to = (r.emp_start || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || to === (r.start_date || '').slice(0, 10)) continue;
    setStartDate(r.id, to, now);
    changed.push({ id: r.id, name: r.name, from: r.start_date, to });
  }
  return changed;
}

/** Best address for the hire's manager: the person who filled the intake link, else the manager's
 *  work email from the roster. Null when neither is known. */
export function managerEmailFor(requestId: number): string | null {
  const db = getDb();
  const link = db.prepare(`SELECT recipient_email FROM intake_links WHERE request_id = ? AND recipient_email IS NOT NULL ORDER BY id DESC LIMIT 1`).get(requestId) as { recipient_email: string } | undefined;
  if (link?.recipient_email) return link.recipient_email;
  const req = db.prepare(`SELECT manager_name FROM onboarding_requests WHERE id = ?`).get(requestId) as { manager_name: string | null } | undefined;
  const mgr = String(req?.manager_name || '').trim().toLowerCase();
  if (!mgr) return null;
  const e = db.prepare(
    `SELECT work_email FROM employees WHERE work_email IS NOT NULL AND employment_status NOT IN ('terminated')
       AND (lower(trim(COALESCE(preferred_name, legal_first_name) || ' ' || legal_last_name)) = ? OR lower(trim(legal_first_name || ' ' || legal_last_name)) = ?)
      LIMIT 1`
  ).get(mgr, mgr) as { work_email: string } | undefined;
  return e?.work_email || null;
}

/** The catalogs the form needs to render, read live from the editable onboarding_catalog table. */
export function getFormOptions() {
  const cat = catalogAll();
  return {
    owners: OWNERS,
    software: cat.software.map((s) => ({ name: s.name, owner: s.owner, kind: s.approval ? 'approval' : 'task' })),
    sharepoint: cat.sharepoint.map((g) => ({ name: g.name, owner: g.owner, kind: g.approval ? 'approval' : 'task' })),
    printers: cat.printer.map((p) => p.name),
    // Computers are chosen by purchase tier (with price), matching the asset-library cost model.
    computers: computerTierList(),
    dockPrice: DOCK_PRICE,
    // App-access roles (pick one each): Sage (priced, -> Accounting) and ServiceTrade (-> Laura).
    sage: cat.sage.map((s) => ({ name: s.name, spec: s.spec, price: s.price })),
    servicetrade: cat.servicetrade.map((s) => ({ name: s.name, spec: s.spec })),
  };
}
