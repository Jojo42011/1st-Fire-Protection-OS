import { getDb } from '../db/index';

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
export type Owner = 'bamboo' | 'it' | 'mario' | 'rebecca' | 'sandi' | 'denise' | 'daniel';

/** Display label + the tag shown on the form, per owner. Order is the grouped-view order. */
export const OWNERS: { key: Owner; label: string; tag: string }[] = [
  { key: 'bamboo', label: 'BambooHR (Sandi builds it)', tag: 'BambooHR' },
  { key: 'it', label: 'IT (provisioning)', tag: 'IT' },
  { key: 'mario', label: 'Mario (approval)', tag: 'Mario' },
  { key: 'rebecca', label: 'Rebecca (Accounting approval)', tag: 'Rebecca' },
  { key: 'sandi', label: 'Sandi (HR approval)', tag: 'Sandi' },
  { key: 'denise', label: 'Denise McAndrew (Safety team)', tag: 'Safety' },
  { key: 'daniel', label: 'Daniel Mendoza (Safety team)', tag: 'Safety' },
];
const OWNER_LABEL: Record<Owner, string> = OWNERS.reduce(
  (m, o) => ((m[o.key] = o.label), m),
  {} as Record<Owner, string>
);
const OWNER_ORDER: Owner[] = OWNERS.map((o) => o.key);

/* ─────────────────────────── the option catalogs ─────────────────────────── */

/** Software the form offers, and who each one routes to when selected. */
export const SOFTWARE: { name: string; owner: Owner; kind: 'task' | 'approval' }[] = [
  { name: 'Microsoft 365 desktop apps', owner: 'it', kind: 'task' },
  { name: 'Adobe Acrobat', owner: 'it', kind: 'task' },
  { name: 'HFSS', owner: 'it', kind: 'task' },
  { name: 'Bluebeam', owner: 'mario', kind: 'approval' },
  { name: 'AutoCAD', owner: 'mario', kind: 'approval' },
  { name: 'HydraCAD', owner: 'mario', kind: 'approval' },
];
const SOFTWARE_ROUTING = new Map(SOFTWARE.map((s) => [s.name, s]));

/** SharePoint groups the form offers, and who each one routes to when selected. */
export const SHAREPOINT: { name: string; owner: Owner; kind: 'task' | 'approval' }[] = [
  // the IT-provisioned location/function groups
  { name: 'Austin', owner: 'it', kind: 'task' },
  { name: 'College Station', owner: 'it', kind: 'task' },
  { name: 'Extinguisher (Not 1FP)', owner: 'it', kind: 'task' },
  { name: 'FIRCON', owner: 'it', kind: 'task' },
  { name: 'Lubbock', owner: 'it', kind: 'task' },
  { name: 'McAllen', owner: 'it', kind: 'task' },
  { name: 'One Stop', owner: 'it', kind: 'task' },
  { name: 'SAFETY', owner: 'it', kind: 'task' },
  { name: 'San Antonio (FPS)', owner: 'it', kind: 'task' },
  { name: 'SP 1st FP Extinguishers', owner: 'it', kind: 'task' },
  { name: 'WACO', owner: 'it', kind: 'task' },
  // the approval-gated groups
  { name: 'MGMT', owner: 'mario', kind: 'approval' },
  { name: 'ACCT', owner: 'rebecca', kind: 'approval' },
  { name: 'Payroll', owner: 'rebecca', kind: 'approval' },
  { name: 'HR', owner: 'sandi', kind: 'approval' },
];
const SHAREPOINT_ROUTING = new Map(SHAREPOINT.map((g) => [g.name, g]));

/** Printers the form offers - every printer routes to IT. */
export const PRINTERS: string[] = [
  'San Antonio Regular',
  'San Antonio Plotter',
  'San Antonio Accounting',
  'San Antonio Safety',
  'Buda Regular',
  'Buda Plotter',
  'McAllen Regular',
  'McAllen Plotter',
  'Waco Regular',
  'Waco Plotter',
];

/** The computer choices and the spec each carries (for the Mario approval detail). */
export const COMPUTERS: { key: string; label: string; spec: string }[] = [
  { key: 'standard', label: 'Standard', spec: 'Standard T16 / Ryzen 7 / 16GB / 512GB' },
  { key: 'business', label: 'Business', spec: 'Business T16 / Ryzen 7 / 32GB / 512GB' },
  { key: 'cad', label: 'CAD', spec: 'CAD P16s / Ultra 7 / 32GB / 1TB / 6GB GPU' },
];
const COMPUTER_SPEC: Record<string, string> = COMPUTERS.reduce(
  (m, c) => ((m[c.key] = c.spec), m),
  {} as Record<string, string>
);

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
  software?: string[];
  sharepoint?: string[];
  printers?: string[];
}

export interface OnboardingItem {
  id: number;
  request_id: number;
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
}

const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'on';

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
    const s = SOFTWARE_ROUTING.get(name);
    if (!s) continue;
    if (s.kind === 'approval')
      items.push({ owner: s.owner, kind: 'approval', label: `Approve ${name} license`, detail: 'Premium software - needs Mario sign-off.' });
    else items.push({ owner: s.owner, kind: 'task', label: `Install ${name}` });
  }

  // ── SharePoint groups (IT, or Mario/Rebecca/Sandi approval per group) ──
  const groups: string[] = safeArray(req.sharepoint_json);
  for (const name of groups) {
    const g = SHAREPOINT_ROUTING.get(name);
    if (!g) continue;
    if (g.kind === 'approval')
      items.push({ owner: g.owner, kind: 'approval', label: `Approve SharePoint group: ${name}`, detail: 'Restricted group - needs approval before access.' });
    else items.push({ owner: g.owner, kind: 'task', label: `Add to SharePoint group: ${name}` });
  }

  // ── printers (all IT) ──
  const printers: string[] = safeArray(req.printers_json);
  for (const name of printers) items.push({ owner: 'it', kind: 'task', label: `Connect printer: ${name}` });

  // ── Mario: new computer (approval, carrying the spec) ──
  const ct = (req.computer_type || 'none') as string;
  if (ct && ct !== 'none' && COMPUTER_SPEC[ct]) {
    items.push({ owner: 'mario', kind: 'approval', label: 'Approve new computer', detail: COMPUTER_SPEC[ct] });
  }

  // ── Safety (Denise): equipment tasks ──
  if (bool(req.company_cell)) items.push({ owner: 'denise', kind: 'task', label: 'Issue company cell phone' });
  if (bool(req.ipad)) items.push({ owner: 'denise', kind: 'task', label: 'Issue company iPad' });
  if (bool(req.vehicle_transfer)) items.push({ owner: 'denise', kind: 'task', label: 'Company vehicle transfer' });
  if (bool(req.wex_card)) items.push({ owner: 'denise', kind: 'task', label: 'Issue WEX fuel card' });

  // ── company vehicle needed -> THREE items across Sandi, Denise, Daniel ──
  if (bool(req.company_vehicle)) {
    const vd = (req.vehicle_details || '').trim();
    items.push({ owner: 'sandi', kind: 'task', label: "Send driver's license to Denise + run motor vehicle report" });
    items.push({ owner: 'denise', kind: 'task', label: 'Add to State Auto Policy (after the MVR clears)' });
    items.push({
      owner: 'daniel',
      kind: 'task',
      label: 'Confirm the vehicle / new-vehicle details',
      detail: vd || undefined,
    });
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
        (name, personal_email, start_date, cell_phone, job_position, salary, manager_name,
         company_email, teams_number, cell_reimburse, pto_plan, hours_80_40, probation_waived,
         incentive_plan, vehicle_allowance, misc_exceptions, company_cell, ipad, company_vehicle,
         vehicle_details, vehicle_transfer, wex_card, computer_type, software_json, sharepoint_json, printers_json)
       VALUES
        (@name, @personal_email, @start_date, @cell_phone, @job_position, @salary, @manager_name,
         @company_email, @teams_number, @cell_reimburse, @pto_plan, @hours_80_40, @probation_waived,
         @incentive_plan, @vehicle_allowance, @misc_exceptions, @company_cell, @ipad, @company_vehicle,
         @vehicle_details, @vehicle_transfer, @wex_card, @computer_type, @software_json, @sharepoint_json, @printers_json)`
    )
    .run({
      name: String(payload.name).trim(),
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
      software_json: JSON.stringify(Array.isArray(payload.software) ? payload.software : []),
      sharepoint_json: JSON.stringify(Array.isArray(payload.sharepoint) ? payload.sharepoint : []),
      printers_json: JSON.stringify(Array.isArray(payload.printers) ? payload.printers : []),
    });

  const requestId = Number(info.lastInsertRowid);
  const req = db.prepare(`SELECT * FROM onboarding_requests WHERE id = ?`).get(requestId);

  const drafts = routeItems(req);
  const insItem = db.prepare(
    `INSERT INTO onboarding_items (request_id, owner, owner_label, kind, label, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const d of drafts) insItem.run(requestId, d.owner, OWNER_LABEL[d.owner], d.kind, d.label, d.detail || null);

  return { request: req, items: itemsFor(requestId) };
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

/** Every request with a progress rollup, newest first (the board). */
export function listRequests(): (any & { rollup: RequestRollup })[] {
  const db = getDb();
  const requests = db.prepare(`SELECT * FROM onboarding_requests ORDER BY id DESC`).all() as any[];
  return requests.map((r) => ({ ...r, rollup: rollupFor(itemsFor(r.id)) }));
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
/** Approve an approval (the human gate; approval -> approved). */
export function approveItem(id: number, by = 'operator'): OnboardingItem {
  return decide(id, 'approved', 'approval', by);
}
/** Reject an approval (the human gate; approval -> rejected). */
export function rejectItem(id: number, by = 'operator'): OnboardingItem {
  return decide(id, 'rejected', 'approval', by);
}

/** A request flips to 'complete' once no item is still pending (nothing is owed). */
function recomputeRequestStatus(requestId: number): void {
  const db = getDb();
  const pending = db
    .prepare(`SELECT COUNT(*) AS c FROM onboarding_items WHERE request_id = ? AND status = 'pending'`)
    .get(requestId) as { c: number };
  const status = pending.c === 0 ? 'complete' : 'open';
  db.prepare(`UPDATE onboarding_requests SET status = ? WHERE id = ?`).run(status, requestId);
}

/** The catalogs the form needs to render (single source of truth). */
export function getFormOptions() {
  return {
    owners: OWNERS,
    software: SOFTWARE,
    sharepoint: SHAREPOINT,
    printers: PRINTERS,
    computers: COMPUTERS,
  };
}
