import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';

/**
 * Offboarding engine: the account + mailbox lifecycle after a termination.
 *
 * createOffboarding() stores one request per departing person and routes it into dated items across
 * the SOP stages:
 *   S1 (last working day): disable, reset + revoke sessions, hide from GAL, remove groups (snapshot
 *       first), forward to manager, auto-reply, reassign files.
 *   S2 (within a week): convert mailbox to shared, remove the 365 license (stop paying).
 *   S3 (forward_until, default +90d): stop forwarding + auto-reply.
 *   S4 (retain_until): retire the account. Delete the AD object (approval), and either delete the
 *       shared mailbox (approval) or keep it on hold (task), per the per-person mailbox choice.
 *
 * Destructive steps are approvals, not tasks, so nothing is deleted without an explicit click.
 * Execution against AD/365 lands in a later phase; here the items carry action codes and due dates.
 */

/* ─────────────────────────── owners ─────────────────────────── */
export type OffOwner = 'it' | 'manager' | 'accounting' | 'hr';
const OWNER_LABEL: Record<OffOwner, string> = { it: 'IT', manager: 'Manager', accounting: 'Accounting', hr: 'HR' };

/* ─────────────────────────── policy (editable defaults) ─────────────────────────── */
const K_FORWARD_DAYS = 'offboard_forward_days';
const K_RETAIN_DAYS = 'offboard_retain_days';
const DEFAULT_FORWARD_DAYS = 90;
const DEFAULT_RETAIN_DAYS = 180;

export interface OffboardingPolicy { forwardDays: number; retainDays: number }
export function getPolicy(): OffboardingPolicy {
  const f = Number(getState(K_FORWARD_DAYS));
  const r = Number(getState(K_RETAIN_DAYS));
  return { forwardDays: Number.isFinite(f) && f > 0 ? f : DEFAULT_FORWARD_DAYS, retainDays: Number.isFinite(r) && r > 0 ? r : DEFAULT_RETAIN_DAYS };
}
export function setPolicy(patch: { forwardDays?: number; retainDays?: number }): OffboardingPolicy {
  if (patch.forwardDays !== undefined && Number(patch.forwardDays) > 0) setState(K_FORWARD_DAYS, String(Math.round(Number(patch.forwardDays))));
  if (patch.retainDays !== undefined && Number(patch.retainDays) > 0) setState(K_RETAIN_DAYS, String(Math.round(Number(patch.retainDays))));
  return getPolicy();
}

/* ─────────────────────────── date helpers ─────────────────────────── */
const today = (): string => new Date().toISOString().slice(0, 10);
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return addDays(today(), days);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ─────────────────────────── types ─────────────────────────── */
export interface OffboardingPayload {
  employee_id?: number;
  object_guid?: string;
  name: string;
  upn?: string;
  sam?: string;
  manager_email?: string;
  office?: string;
  termination_date?: string;
  last_working_date?: string;
  forward_to?: string;
  mailbox_action?: 'delete' | 'hold';
  source?: 'manual' | 'backlog';
  created_by?: string;
}

interface DraftItem {
  owner: OffOwner;
  stage: 's1' | 's2' | 's3' | 's4';
  kind: 'task' | 'timed' | 'approval';
  action_code: string;
  label: string;
  detail?: string;
  due_at: string;
  snapshot_json?: string;
}

/* ─────────────────────────── the plan ─────────────────────────── */
function planItems(req: any, groupSnapshot: { name: string }[] | null): DraftItem[] {
  const base = req.last_working_date || req.termination_date || today();
  const s2 = addDays(base, 7);
  const fwd = req.forward_until as string;
  const retain = req.retain_until as string;
  const fwdTo = req.forward_to || req.manager_email || 'the manager';
  const groupCount = groupSnapshot ? groupSnapshot.length : 0;

  const items: DraftItem[] = [
    { owner: 'it', stage: 's1', kind: 'task', action_code: 'ad_disable', label: 'Disable the AD account', due_at: base },
    { owner: 'it', stage: 's1', kind: 'task', action_code: 'revoke_sessions', label: 'Reset the password and revoke 365 sessions', detail: 'Signs out any open session so a device cannot keep sending.', due_at: base },
    { owner: 'it', stage: 's1', kind: 'task', action_code: 'gal_hide', label: 'Hide from the global address list', due_at: base },
    { owner: 'it', stage: 's1', kind: 'task', action_code: 'groups_remove', label: 'Remove from security and distribution groups', detail: groupCount ? `${groupCount} group${groupCount === 1 ? '' : 's'} captured for audit before removal.` : 'Group membership captured for audit before removal.', due_at: base, snapshot_json: groupSnapshot ? JSON.stringify(groupSnapshot) : undefined },
    { owner: 'it', stage: 's1', kind: 'task', action_code: 'fwd_set', label: `Forward mail to ${fwdTo} until ${fwd}`, due_at: base },
    { owner: 'it', stage: 's1', kind: 'task', action_code: 'autoreply_set', label: 'Set the mailbox auto-reply', due_at: base },
    { owner: 'manager', stage: 's1', kind: 'task', action_code: 'data_reassign', label: 'Reassign OneDrive and shared files', detail: 'Grant the manager access to the departing user\'s files.', due_at: base },

    { owner: 'it', stage: 's2', kind: 'task', action_code: 'mbx_shared', label: 'Convert the mailbox to a shared mailbox', due_at: s2 },
    { owner: 'accounting', stage: 's2', kind: 'task', action_code: 'license_remove', label: 'Remove the Microsoft 365 license', detail: 'Frees the paid seat once the mailbox is shared.', due_at: s2 },

    { owner: 'it', stage: 's3', kind: 'timed', action_code: 'fwd_stop', label: `Stop forwarding and auto-reply (on ${fwd})`, due_at: fwd },
  ];

  // S4: retire. Deleting the AD object is always an approval.
  items.push({ owner: 'it', stage: 's4', kind: 'approval', action_code: 'ad_delete', label: `Delete the AD account (on ${retain})`, detail: 'Do this last: with hybrid sync, deleting the AD object retires the synced identity.', due_at: retain });
  if (req.mailbox_action === 'hold') {
    items.push({ owner: 'it', stage: 's4', kind: 'task', action_code: 'mbx_hold', label: 'Keep the mailbox as an inactive mailbox on hold', detail: 'Preserved for compliance instead of deletion.', due_at: retain });
  } else {
    items.push({ owner: 'it', stage: 's4', kind: 'approval', action_code: 'mbx_delete', label: `Delete the shared mailbox (on ${retain})`, due_at: retain });
  }
  return items;
}

/* ─────────────────────────── create / read ─────────────────────────── */
export function createOffboarding(payload: OffboardingPayload): { request: any; items: any[] } {
  const db = getDb();
  // When the picker passes an employee_id, fill any identity fields the caller left blank.
  if (payload && payload.employee_id) {
    const r = resolveOffboardingFromEmployee(Number(payload.employee_id));
    payload = {
      ...r, ...payload,
      name: payload.name || r.name || '',
      upn: payload.upn || r.upn,
      sam: payload.sam || r.sam,
      object_guid: payload.object_guid || r.object_guid,
      office: payload.office || r.office,
      manager_email: payload.manager_email || r.manager_email,
    };
  }
  if (!payload || !payload.name || !String(payload.name).trim()) throw new Error('name is required');
  const policy = getPolicy();
  const base = payload.last_working_date || payload.termination_date || today();
  const forward_until = addDays(base, policy.forwardDays);
  const retain_until = addDays(base, policy.retainDays);
  const mailbox_action = payload.mailbox_action === 'hold' ? 'hold' : 'delete';

  const info = db
    .prepare(
      `INSERT INTO offboarding_requests
        (employee_id, object_guid, name, upn, sam, manager_email, office, termination_date,
         last_working_date, forward_to, forward_until, retain_until, mailbox_action, source, created_by)
       VALUES (@employee_id,@object_guid,@name,@upn,@sam,@manager_email,@office,@termination_date,
         @last_working_date,@forward_to,@forward_until,@retain_until,@mailbox_action,@source,@created_by)`
    )
    .run({
      employee_id: payload.employee_id || null,
      object_guid: payload.object_guid || null,
      name: String(payload.name).trim(),
      upn: payload.upn || null,
      sam: payload.sam || null,
      manager_email: payload.manager_email || null,
      office: payload.office || null,
      termination_date: payload.termination_date || null,
      last_working_date: payload.last_working_date || null,
      forward_to: payload.forward_to || payload.manager_email || null,
      forward_until,
      retain_until,
      mailbox_action,
      source: payload.source === 'backlog' ? 'backlog' : 'manual',
      created_by: payload.created_by || 'operator',
    });

  const requestId = Number(info.lastInsertRowid);
  const req = db.prepare(`SELECT * FROM offboarding_requests WHERE id = ?`).get(requestId) as any;

  // Capture group membership from the AD mirror before anything is removed.
  let groupSnapshot: { name: string }[] | null = null;
  if (req.object_guid) {
    const groups = db.prepare(`SELECT group_name AS name FROM ad_user_groups WHERE object_guid = ?`).all(req.object_guid) as { name: string }[];
    groupSnapshot = groups.length ? groups : null;
  }

  const drafts = planItems(req, groupSnapshot);
  const ins = db.prepare(
    `INSERT INTO offboarding_items (request_id, owner, owner_label, stage, kind, action_code, label, detail, due_at, snapshot_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  for (const d of drafts) ins.run(requestId, d.owner, OWNER_LABEL[d.owner], d.stage, d.kind, d.action_code, d.label, d.detail || null, d.due_at, d.snapshot_json || null);

  return { request: req, items: itemsFor(requestId) };
}

function itemsFor(requestId: number): any[] {
  return getDb().prepare(`SELECT * FROM offboarding_items WHERE request_id = ? ORDER BY id ASC`).all(requestId);
}

export interface OffRollup { total: number; done: number; pending: number; pendingApprovals: number; progress: number }
function rollup(items: any[]): OffRollup {
  const total = items.length;
  const done = items.filter((i) => i.status === 'done' || i.status === 'approved' || i.status === 'skipped').length;
  const pending = items.filter((i) => i.status === 'pending').length;
  const pendingApprovals = items.filter((i) => i.kind === 'approval' && i.status === 'pending').length;
  return { total, done, pending, pendingApprovals, progress: total ? Math.round((done / total) * 100) : 0 };
}

export function getOffboarding(id: number): { request: any; items: any[]; rollup: OffRollup } | null {
  const db = getDb();
  const request = db.prepare(`SELECT * FROM offboarding_requests WHERE id = ?`).get(id);
  if (!request) return null;
  const items = itemsFor(id);
  return { request, items, rollup: rollup(items) };
}

export function listOffboarding(): any[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM offboarding_requests ORDER BY id DESC`).all() as any[];
  return rows.map((r) => ({ ...r, rollup: rollup(itemsFor(r.id)) }));
}

/** Whether a person already has an offboarding request (any status), to avoid duplicates. */
export function hasOffboarding(opts: { employee_id?: number; upn?: string; object_guid?: string }): boolean {
  const db = getDb();
  if (opts.employee_id) { if (db.prepare(`SELECT 1 FROM offboarding_requests WHERE employee_id = ? LIMIT 1`).get(opts.employee_id)) return true; }
  if (opts.object_guid) { if (db.prepare(`SELECT 1 FROM offboarding_requests WHERE object_guid = ? LIMIT 1`).get(opts.object_guid)) return true; }
  if (opts.upn) { if (db.prepare(`SELECT 1 FROM offboarding_requests WHERE lower(upn) = lower(?) LIMIT 1`).get(opts.upn)) return true; }
  return false;
}

/* ─────────────────────────── decisions ─────────────────────────── */
export function decideItem(id: number, verb: 'complete' | 'approve' | 'reject' | 'skip', by = 'operator'): any {
  const db = getDb();
  const item = db.prepare(`SELECT * FROM offboarding_items WHERE id = ?`).get(id) as any;
  if (!item) throw new Error(`item ${id} not found`);
  if (verb === 'approve' || verb === 'reject') {
    if (item.kind !== 'approval') throw new Error(`item ${id} is a ${item.kind}, not an approval`);
  } else if (verb === 'complete') {
    if (item.kind === 'approval') throw new Error(`item ${id} is an approval; approve or reject it`);
  }
  const next = verb === 'complete' ? 'done' : verb === 'approve' ? 'approved' : verb === 'reject' ? 'rejected' : 'skipped';
  if (item.status === 'pending') {
    db.prepare(`UPDATE offboarding_items SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`).run(next, by, id);
  }
  recompute(item.request_id);
  return db.prepare(`SELECT * FROM offboarding_items WHERE id = ?`).get(id);
}

export function cancelOffboarding(id: number, by = 'operator'): boolean {
  const db = getDb();
  const r = db.prepare(`UPDATE offboarding_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status != 'cancelled'`).run(id);
  return r.changes > 0;
}

function recompute(requestId: number): void {
  const db = getDb();
  const pending = db.prepare(`SELECT COUNT(*) AS c FROM offboarding_items WHERE request_id = ? AND status = 'pending'`).get(requestId) as { c: number };
  const cur = db.prepare(`SELECT status FROM offboarding_requests WHERE id = ?`).get(requestId) as { status: string } | undefined;
  if (cur && cur.status === 'cancelled') return;
  db.prepare(`UPDATE offboarding_requests SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(pending.c === 0 ? 'complete' : 'open', requestId);
}

/* ─────────────────────────── people picker + manager auto-fill ─────────────────────────── */

const lc = (s: string | null | undefined) => String(s || '').toLowerCase().trim();
const empFullName = (e: any) => `${e.preferred_name || e.legal_first_name || ''} ${e.legal_last_name || ''}`.trim();
// BambooHR stores a manager as "Last, First"; employee names are "First Last". Flip so they match.
const flipComma = (s: string) => {
  const t = String(s || '').trim();
  if (t.includes(',')) { const [last, ...rest] = t.split(','); return `${rest.join(',').trim()} ${last.trim()}`.trim(); }
  return t;
};
/** Resolve a manager name (either order) to a work email via the name->email map. */
function mgrEmail(n2e: Map<string, string>, name: string | null | undefined): string | null {
  if (!name) return null;
  return n2e.get(lc(name)) || n2e.get(lc(flipComma(name))) || null;
}

/** Name -> work email, over active employees, so a manager's display name (BambooHR stores the manager
 *  as a name, not an address) can be resolved to an email for forwarding. */
function nameToEmail(): Map<string, string> {
  const db = getDb();
  const m = new Map<string, string>();
  // BambooHR employees first (their work email is the preferred forward target).
  const rows = db.prepare(
    `SELECT legal_first_name, legal_last_name, preferred_name, entra_display_name, work_email
       FROM employees WHERE work_email IS NOT NULL AND work_email != ''`
  ).all() as any[];
  for (const r of rows) {
    const email = r.work_email;
    for (const n of [empFullName(r), `${r.legal_first_name || ''} ${r.legal_last_name || ''}`.trim(), r.entra_display_name]) {
      if (n && !m.has(lc(n))) m.set(lc(n), email);
    }
  }
  // Fall back to the AD/Entra mirror for anyone the BambooHR table did not cover (email, else UPN).
  const ad = db.prepare(
    `SELECT display_name, given_name, surname, email, upn FROM ad_users WHERE enabled = 1`
  ).all() as any[];
  for (const a of ad) {
    const addr = a.email || a.upn;
    if (!addr) continue;
    for (const n of [a.display_name, `${a.given_name || ''} ${a.surname || ''}`.trim()]) {
      if (n && !m.has(lc(n))) m.set(lc(n), addr);
    }
  }
  return m;
}

export interface PickEmployee {
  id: number; name: string; work_email: string | null; upn: string | null; sam: string | null;
  office: string | null; title: string | null; manager: string | null; manager_email: string | null;
  object_guid: string | null; department: string | null; status: string;
}

/** Active (not terminated/prehire) employees for the offboarding picker, each with their manager
 *  resolved to an email. */
export function listActiveEmployeesForOffboarding(): PickEmployee[] {
  const db = getDb();
  const n2e = nameToEmail();
  const rows = db.prepare(
    `SELECT id, legal_first_name, legal_last_name, preferred_name, entra_display_name, work_email, upn,
            ad_username, entra_object_id, office, department, public_job_title, job_position, manager, employment_status
       FROM employees
      WHERE employment_status NOT IN ('terminated','prehire')
      ORDER BY legal_last_name, legal_first_name`
  ).all() as any[];
  return rows.map((e) => ({
    id: e.id,
    name: empFullName(e) || e.work_email || `#${e.id}`,
    work_email: e.work_email || null,
    upn: e.upn || null,
    sam: e.ad_username || null,
    office: e.office || null,
    title: e.public_job_title || e.job_position || null,
    manager: e.manager || null,
    manager_email: mgrEmail(n2e, e.manager),
    object_guid: e.entra_object_id || null,
    department: e.department || null,
    status: e.employment_status,
  }));
}

/** Distinct managers among active employees, resolved to an email where possible, for the dropdown. */
export function listManagers(): { name: string; email: string | null }[] {
  const db = getDb();
  const n2e = nameToEmail();
  const rows = db.prepare(
    `SELECT DISTINCT manager FROM employees
      WHERE manager IS NOT NULL AND manager != '' AND employment_status NOT IN ('terminated','prehire')
      ORDER BY manager`
  ).all() as { manager: string }[];
  return rows.map((r) => ({ name: r.manager, email: mgrEmail(n2e, r.manager) }));
}

/** Fill in a departing person's identity from their employee row when the caller passes employee_id. */
export function resolveOffboardingFromEmployee(employeeId: number): Partial<OffboardingPayload> {
  const db = getDb();
  const e = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(employeeId) as any;
  if (!e) return {};
  const n2e = nameToEmail();
  // Prefer the AD mirror for sam/guid if the employee row is thin.
  const ad = db.prepare(
    `SELECT sam, upn, object_guid FROM ad_users WHERE (upn IS NOT NULL AND lower(upn)=lower(?)) OR (sam IS NOT NULL AND lower(sam)=lower(?)) LIMIT 1`
  ).get(e.upn || e.work_email || '', e.ad_username || '') as any;
  return {
    employee_id: e.id,
    name: empFullName(e),
    upn: e.upn || (ad && ad.upn) || e.work_email || undefined,
    sam: e.ad_username || (ad && ad.sam) || undefined,
    object_guid: e.entra_object_id || (ad && ad.object_guid) || undefined,
    office: e.office || undefined,
    manager_email: mgrEmail(n2e, e.manager) || undefined,
  };
}

/* ─────────────────────────── DC-executable actions ─────────────────────────── */

// Which checklist actions the DC agent can run on-prem, and the job kind each maps to.
const AD_JOB_KIND: Record<string, string> = {
  ad_disable: 'ad_disable_user',
  groups_remove: 'ad_remove_groups',
  ad_delete: 'ad_delete_user',
};

export function isDcExecutable(actionCode: string): boolean {
  return !!AD_JOB_KIND[actionCode];
}

/** Build the DC agent job (kind + payload) for one offboarding item, or an error if it is not a
 *  DC-executable action or the person cannot be resolved to a SAM. */
export function buildItemJob(itemId: number): { ok: boolean; error?: string; kind?: string; payload?: any; requestId?: number } {
  const db = getDb();
  const item = db.prepare(`SELECT * FROM offboarding_items WHERE id = ?`).get(itemId) as any;
  if (!item) return { ok: false, error: 'item not found' };
  const kind = AD_JOB_KIND[item.action_code];
  if (!kind) return { ok: false, error: `"${item.action_code}" is not a DC-executable action (mailbox/cloud steps run elsewhere)` };
  const req = db.prepare(`SELECT * FROM offboarding_requests WHERE id = ?`).get(item.request_id) as any;
  if (!req) return { ok: false, error: 'request not found' };
  // Resolve the SAM: request, else the AD mirror by upn/guid.
  let sam = req.sam as string | null;
  let upn = req.upn as string | null;
  if (!sam) {
    const ad = db.prepare(
      `SELECT sam, upn FROM ad_users WHERE (object_guid IS NOT NULL AND object_guid = ?) OR (upn IS NOT NULL AND lower(upn)=lower(?)) LIMIT 1`
    ).get(req.object_guid || '', req.upn || '') as any;
    if (ad) { sam = sam || ad.sam; upn = upn || ad.upn; }
  }
  if (!sam) return { ok: false, error: 'no sAMAccountName on file for this person; set it on the request first' };
  return { ok: true, kind, requestId: req.id, payload: { sam, upn, name: req.name, requestId: req.id } };
}

/** Called by the job queue when a DC offboarding job finishes: mark the linked item done. */
export function applyOffboardingJobResult(itemId: number, _kind: string, _result: any): void {
  const db = getDb();
  const item = db.prepare(`SELECT status FROM offboarding_items WHERE id = ?`).get(itemId) as { status: string } | undefined;
  if (!item || item.status !== 'pending') return;
  db.prepare(`UPDATE offboarding_items SET status = 'done', decided_by = 'dc-agent', decided_at = datetime('now') WHERE id = ?`).run(itemId);
  const reqRow = db.prepare(`SELECT request_id FROM offboarding_items WHERE id = ?`).get(itemId) as { request_id: number } | undefined;
  if (reqRow) recompute(reqRow.request_id);
}
