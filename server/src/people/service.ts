/**
 * People / Employee Lifecycle — data service (the DB-facing layer over the pure routing engine).
 *
 * Persists employees, workflows, tasks, access, assets, credentials and the audit trail. Task
 * lifecycle honors dependencies: an approval-gated provisioning task stays `blocked` until its
 * approval is granted; completing a task unblocks anything waiting on it. Offboarding reverses the
 * employee's ACTUAL recorded footprint. Nothing here performs a destructive external action — it
 * generates human-confirmed workflow tasks; real provisioning/de-provisioning is a later phase.
 */
import { getDb } from '../db/index';
import { JOB_POSITIONS } from './catalog';
import { routeOnboarding, routeOffboarding, OnboardingIntake, WorkItem, Footprint } from './routing';
import { fetchRosterForImport, bambooConfigured, BambooImportRow } from '../services/bamboo';
import { addUserToGroup, removeUserFromGroup, graphConfigured } from '../services/msGraphGroups';

/* ─────────────────────────── catalog seeding (real config, not demo data) ─────────────────────────── */
export function seedPeopleCatalog(): void {
  const db = getDb();
  const insPos = db.prepare(`INSERT OR IGNORE INTO job_positions (name) VALUES (?)`);
  const insTpl = db.prepare(`INSERT OR IGNORE INTO role_templates (position, review_status, defaults_json) VALUES (?, 'unreviewed', '{}')`);
  const tx = db.transaction(() => {
    for (const name of JOB_POSITIONS) { insPos.run(name); insTpl.run(name); }
  });
  tx();
}

/* ─────────────────────────── audit ─────────────────────────── */
export function audit(action: string, detail: string, opts: { actor?: string; employee_id?: number; workflow_id?: number } = {}): void {
  getDb()
    .prepare(`INSERT INTO people_audit (employee_id, workflow_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)`)
    .run(opts.employee_id ?? null, opts.workflow_id ?? null, opts.actor || 'system', action, detail);
}

/* ─────────────────────────── task status from a routed work item ─────────────────────────── */
function initialStatus(w: WorkItem): string {
  if (w.kind === 'approval') return 'awaiting_approval';
  if (w.dependsOn) return 'blocked';
  return 'pending';
}

/* ─────────────────────────── onboarding ─────────────────────────── */
export interface NewHire {
  legal_first_name?: string; legal_last_name?: string; preferred_name?: string;
  personal_email?: string; personal_phone?: string; work_email?: string;
  office?: string; department?: string; job_position?: string; public_job_title?: string;
  manager?: string; employment_type?: string; anticipated_start_date?: string;
  intake?: OnboardingIntake;
}

export function createOnboarding(hire: NewHire, actor: string): { employee_id: number; workflow_id: number; tasks: number } {
  const db = getDb();
  const empInfo = db.prepare(
    `INSERT INTO employees (legal_first_name, legal_last_name, preferred_name, personal_email, personal_phone, work_email,
        office, department, job_position, public_job_title, manager, employment_type, anticipated_start_date, employment_status)
     VALUES (@fn, @ln, @pn, @pe, @pp, @we, @office, @dept, @pos, @title, @mgr, @type, @start, 'onboarding')`
  ).run({
    fn: hire.legal_first_name || null, ln: hire.legal_last_name || null, pn: hire.preferred_name || null,
    pe: hire.personal_email || null, pp: hire.personal_phone || null, we: hire.work_email || null,
    office: hire.office || null, dept: hire.department || null, pos: hire.job_position || null,
    title: hire.public_job_title || null, mgr: hire.manager || null, type: hire.employment_type || null,
    start: hire.anticipated_start_date || null,
  });
  const employee_id = Number(empInfo.lastInsertRowid);

  const intake: OnboardingIntake = hire.intake || {};
  const wfInfo = db.prepare(
    `INSERT INTO people_workflows (employee_id, kind, status, initiated_by, manager, intake_json)
     VALUES (?, 'onboarding', 'open', ?, ?, ?)`
  ).run(employee_id, actor, hire.manager || null, JSON.stringify(intake));
  const workflow_id = Number(wfInfo.lastInsertRowid);

  const items = routeOnboarding(intake);
  persistItems(workflow_id, employee_id, items, 'onboarding');

  audit('onboarding_initiated', `Onboarding started for ${displayName(hire)} (${hire.job_position || 'no position'})`, { actor, employee_id, workflow_id });
  audit('form_submitted', `${items.length} work items routed`, { actor, employee_id, workflow_id });
  return { employee_id, workflow_id, tasks: items.length };
}

function persistItems(workflow_id: number, employee_id: number, items: WorkItem[], mode: 'onboarding' | 'offboarding'): void {
  const db = getDb();
  const insTask = db.prepare(
    `INSERT INTO people_tasks (workflow_id, employee_id, category, team, kind, title, detail, status, item_key, depends_on_key, approver_role, system, asset_type)
     VALUES (@wf, @emp, @cat, @team, @kind, @title, @detail, @status, @key, @dep, @role, @sys, @asset)`
  );
  const insAccess = db.prepare(
    `INSERT INTO employee_access (employee_id, system, label, status, owner, approver) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const w of items) {
      insTask.run({
        wf: workflow_id, emp: employee_id, cat: w.category, team: w.team, kind: w.kind, title: w.title,
        detail: w.detail || null, status: initialStatus(w), key: w.key, dep: w.dependsOn || null,
        role: w.approverRole || null, sys: w.system || null, asset: w.assetType || null,
      });
      // Onboarding: record the intended access footprint up front (provisioning flips it to provisioned).
      if (mode === 'onboarding' && w.system && w.kind === 'task') {
        insAccess.run(employee_id, w.system, w.title.replace(/^Provision |^Grant /, ''), w.dependsOn ? 'awaiting_approval' : 'requested', w.team, null);
      }
    }
  });
  tx();
}

/* ─────────────────────────── task decisions (the human gate + dependency engine) ─────────────────────────── */
interface TaskRow {
  id: number; workflow_id: number; employee_id: number; kind: string; status: string;
  item_key: string | null; approver_role: string | null; system: string | null; asset_type: string | null; title: string; team: string;
}
function getTask(id: number): TaskRow | undefined {
  return getDb().prepare(`SELECT * FROM people_tasks WHERE id = ?`).get(id) as TaskRow | undefined;
}
const OPEN_STATES = ['pending', 'blocked', 'awaiting_approval', 'ready', 'in_progress'];

/** Complete a task. Marks provisioning done, creates assets, unblocks dependents, may finish the workflow. */
export function completeTask(id: number, user: string): TaskRow {
  const db = getDb();
  const t = getTask(id);
  if (!t) throw new Error('task not found');
  if (t.kind !== 'task') throw new Error('not a task (use approve/reject)');
  if (t.status === 'blocked') throw new Error('task is blocked by an unmet dependency');
  if (OPEN_STATES.includes(t.status)) {
    db.prepare(`UPDATE people_tasks SET status = 'completed', completed_by = ?, completed_at = datetime('now') WHERE id = ?`).run(user, id);
    applySideEffects(t, user);
    unblockDependents(t.workflow_id, t.item_key);
    audit('task_completed', t.title, { actor: user, employee_id: t.employee_id, workflow_id: t.workflow_id });
    maybeFinishWorkflow(t.workflow_id);
  }
  return getTask(id)!;
}

/** Approve an approval. Unblocks its dependent provisioning task; marks access approved. */
export function approveTask(id: number, user: string): TaskRow {
  const db = getDb();
  const t = getTask(id);
  if (!t) throw new Error('task not found');
  if (t.kind !== 'approval') throw new Error('not an approval');
  if (OPEN_STATES.includes(t.status)) {
    db.prepare(`UPDATE people_tasks SET status = 'approved', decided_by = ?, completed_at = datetime('now') WHERE id = ?`).run(user, id);
    if (t.system) db.prepare(`UPDATE employee_access SET status = 'approved', approved_at = datetime('now') WHERE employee_id = ? AND system = ? AND status != 'provisioned'`).run(t.employee_id, t.system);
    unblockDependents(t.workflow_id, t.item_key);
    audit('approval_approved', t.title, { actor: user, employee_id: t.employee_id, workflow_id: t.workflow_id });
    maybeFinishWorkflow(t.workflow_id);
  }
  return getTask(id)!;
}

/** Reject an approval. Its dependent provisioning task is marked failed (cannot proceed). */
export function rejectTask(id: number, user: string, note?: string): TaskRow {
  const db = getDb();
  const t = getTask(id);
  if (!t) throw new Error('task not found');
  if (t.kind !== 'approval') throw new Error('not an approval');
  if (OPEN_STATES.includes(t.status)) {
    db.prepare(`UPDATE people_tasks SET status = 'rejected', decided_by = ?, detail = COALESCE(detail,'') || ? , completed_at = datetime('now') WHERE id = ?`).run(user, note ? ` · rejected: ${note}` : '', id);
    if (t.item_key) db.prepare(`UPDATE people_tasks SET status = 'failed' WHERE workflow_id = ? AND depends_on_key = ? AND status = 'blocked'`).run(t.workflow_id, t.item_key);
    audit('approval_rejected', t.title + (note ? ` (${note})` : ''), { actor: user, employee_id: t.employee_id, workflow_id: t.workflow_id });
    maybeFinishWorkflow(t.workflow_id);
  }
  return getTask(id)!;
}

function applySideEffects(t: TaskRow, user: string): void {
  const db = getDb();
  // Provisioning a system flips the recorded access to provisioned (or revoked, on offboarding).
  if (t.system) {
    const wf = db.prepare(`SELECT kind FROM people_workflows WHERE id = ?`).get(t.workflow_id) as { kind: string } | undefined;
    if (wf?.kind === 'offboarding') {
      db.prepare(`UPDATE employee_access SET status = 'revoked', revoked_at = datetime('now') WHERE employee_id = ? AND system = ? AND status != 'revoked'`).run(t.employee_id, t.system);
    } else {
      db.prepare(`UPDATE employee_access SET status = 'provisioned', provisioned_at = datetime('now') WHERE employee_id = ? AND system = ?`).run(t.employee_id, t.system);
    }
  }
  // Asset issuance (onboarding) creates the assigned asset; asset recovery (offboarding) returns it.
  if (t.asset_type) {
    const wf = db.prepare(`SELECT kind FROM people_workflows WHERE id = ?`).get(t.workflow_id) as { kind: string } | undefined;
    if (wf?.kind === 'offboarding') {
      db.prepare(`UPDATE employee_assets SET status = 'returned', returned_at = datetime('now'), received_by = ? WHERE employee_id = ? AND asset_type = ? AND status IN ('assigned','pending_return')`).run(user, t.employee_id, t.asset_type);
    } else {
      const exists = db.prepare(`SELECT 1 FROM employee_assets WHERE employee_id = ? AND asset_type = ? AND status = 'assigned'`).get(t.employee_id, t.asset_type);
      if (!exists) db.prepare(`INSERT INTO employee_assets (employee_id, asset_type, status, owner, assigned_at) VALUES (?, ?, 'assigned', ?, datetime('now'))`).run(t.employee_id, t.asset_type, t.team);
    }
  }
}

function unblockDependents(workflow_id: number, item_key: string | null): void {
  if (!item_key) return;
  getDb().prepare(`UPDATE people_tasks SET status = 'pending' WHERE workflow_id = ? AND depends_on_key = ? AND status = 'blocked'`).run(workflow_id, item_key);
}

function maybeFinishWorkflow(workflow_id: number): void {
  const db = getDb();
  const open = (db.prepare(`SELECT COUNT(*) AS c FROM people_tasks WHERE workflow_id = ? AND status IN ('pending','blocked','awaiting_approval','ready','in_progress')`).get(workflow_id) as { c: number }).c;
  if (open > 0) return;
  const wf = db.prepare(`SELECT * FROM people_workflows WHERE id = ?`).get(workflow_id) as any;
  if (!wf || wf.status === 'complete') return;
  db.prepare(`UPDATE people_workflows SET status = 'complete', completed_at = datetime('now') WHERE id = ?`).run(workflow_id);
  if (wf.kind === 'onboarding') {
    db.prepare(`UPDATE employees SET employment_status = 'active', actual_start_date = COALESCE(actual_start_date, anticipated_start_date), updated_at = datetime('now') WHERE id = ?`).run(wf.employee_id);
    audit('employee_activated', 'Onboarding complete; employee is Active', { actor: 'system', employee_id: wf.employee_id, workflow_id });
  } else {
    db.prepare(`UPDATE employees SET employment_status = 'terminated', termination_date = COALESCE(termination_date, date('now')), updated_at = datetime('now') WHERE id = ?`).run(wf.employee_id);
    audit('employee_terminated', 'Offboarding complete; employee is Terminated (history preserved)', { actor: 'system', employee_id: wf.employee_id, workflow_id });
  }
}

/* ─────────────────────────── offboarding (reverse the ACTUAL footprint) ─────────────────────────── */
export function startOffboarding(employee_id: number, opts: { notice_date?: string; last_working_date?: string; termination_type?: string; access_cutoff_at?: string; notes?: string; manager?: string }, actor: string): { workflow_id: number; tasks: number } {
  const db = getDb();
  const emp = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(employee_id) as any;
  if (!emp) throw new Error('employee not found');

  const footprint: Footprint = {
    access: (db.prepare(`SELECT system, label FROM employee_access WHERE employee_id = ? AND status IN ('requested','awaiting_approval','approved','provisioned')`).all(employee_id) as any[]).map((r) => ({ system: r.system, label: r.label })),
    assets: (db.prepare(`SELECT asset_type, identifier FROM employee_assets WHERE employee_id = ? AND status IN ('assigned','pending_return')`).all(employee_id) as any[]).map((r) => ({ assetType: r.asset_type, identifier: r.identifier })),
  };

  const wfInfo = db.prepare(
    `INSERT INTO people_workflows (employee_id, kind, status, initiated_by, manager, notice_date, last_working_date, termination_type, access_cutoff_at, notes)
     VALUES (?, 'offboarding', 'open', ?, ?, ?, ?, ?, ?, ?)`
  ).run(employee_id, actor, opts.manager || null, opts.notice_date || null, opts.last_working_date || null, opts.termination_type || null, opts.access_cutoff_at || null, opts.notes || null);
  const workflow_id = Number(wfInfo.lastInsertRowid);

  db.prepare(`UPDATE employees SET employment_status = 'offboarding', notice_date = ?, last_working_date = ?, termination_type = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(opts.notice_date || null, opts.last_working_date || null, opts.termination_type || null, employee_id);

  const items = routeOffboarding(footprint);
  persistItems(workflow_id, employee_id, items, 'offboarding');
  // Mark assets pending return so the recovery is tracked.
  db.prepare(`UPDATE employee_assets SET status = 'pending_return' WHERE employee_id = ? AND status = 'assigned'`).run(employee_id);

  audit('offboarding_started', `Offboarding started; reversing ${footprint.access.length} access + ${footprint.assets.length} asset(s)`, { actor, employee_id, workflow_id });
  return { workflow_id, tasks: items.length };
}

/* ─────────────────────────── reads ─────────────────────────── */
export function listEmployees(filter: { status?: string; office?: string; q?: string } = {}): any[] {
  const where: string[] = [], args: any[] = [];
  if (filter.status) { where.push('employment_status = ?'); args.push(filter.status); }
  if (filter.office) { where.push('office = ?'); args.push(filter.office); }
  if (filter.q) { where.push('(lower(legal_first_name || " " || legal_last_name) LIKE ? OR lower(preferred_name) LIKE ?)'); args.push(`%${filter.q.toLowerCase()}%`, `%${filter.q.toLowerCase()}%`); }
  const sql = `SELECT id, legal_first_name, legal_last_name, preferred_name, job_position, public_job_title, office, manager, employment_status, work_email, anticipated_start_date, actual_start_date
               FROM employees ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY employment_status, legal_last_name`;
  return getDb().prepare(sql).all(...args);
}

export function getEmployeeDetail(id: number, opts: { includeComp: boolean }): any | null {
  const db = getDb();
  const emp = db.prepare(`SELECT * FROM employees WHERE id = ?`).get(id) as any;
  if (!emp) return null;
  const access = db.prepare(`SELECT id, system, label, access_level, status, owner, external_ref, approved_at, provisioned_at, revoked_at FROM employee_access WHERE employee_id = ? ORDER BY status, system`).all(id);
  const assets = db.prepare(`SELECT id, asset_type, identifier, serial, device_name, status, owner, assigned_at, returned_at, condition FROM employee_assets WHERE employee_id = ? ORDER BY status, asset_type`).all(id);
  const credentials = db.prepare(`SELECT id, credential_type, status, expires_at, verified_at, verified_by FROM employee_credentials WHERE employee_id = ? ORDER BY credential_type`).all(id);
  const workflows = db.prepare(`SELECT id, kind, status, created_at, completed_at FROM people_workflows WHERE employee_id = ? ORDER BY id DESC`).all(id);
  const history = db.prepare(`SELECT actor, action, detail, at FROM people_audit WHERE employee_id = ? ORDER BY id DESC LIMIT 100`).all(id);
  const openWf = db.prepare(`SELECT id FROM people_workflows WHERE employee_id = ? AND kind = 'onboarding' ORDER BY id DESC LIMIT 1`).get(id) as { id: number } | undefined;
  const readiness = openWf ? computeReadiness(openWf.id) : null;
  if (!opts.includeComp) { delete emp.termination_type; } // comp/pay never lives on employees; intake holds it (HR-gated)
  return { employee: emp, access, assets, credentials, workflows, history, readiness };
}

export function listTasks(filter: { team?: string; status?: string; employee_id?: number; kind?: string } = {}): any[] {
  const where: string[] = [], args: any[] = [];
  if (filter.team) { where.push('t.team = ?'); args.push(filter.team); }
  if (filter.kind) { where.push('t.kind = ?'); args.push(filter.kind); }
  if (filter.employee_id) { where.push('t.employee_id = ?'); args.push(filter.employee_id); }
  if (filter.status === 'open') where.push(`t.status IN ('pending','blocked','awaiting_approval','ready','in_progress')`);
  else if (filter.status) { where.push('t.status = ?'); args.push(filter.status); }
  const sql = `SELECT t.*, e.legal_first_name, e.legal_last_name, e.preferred_name, e.job_position, e.office, w.kind AS workflow_kind
               FROM people_tasks t JOIN employees e ON e.id = t.employee_id JOIN people_workflows w ON w.id = t.workflow_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'awaiting_approval' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, t.id DESC`;
  return getDb().prepare(sql).all(...args);
}

/* ─────────────────────────── readiness ─────────────────────────── */
const READINESS_CATEGORIES: { key: string; label: string; match: string[] }[] = [
  { key: 'identity', label: 'Identity', match: ['identity'] },
  { key: 'hardware', label: 'Hardware', match: ['hardware'] },
  { key: 'software', label: 'Software', match: ['software'] },
  { key: 'access', label: 'Access', match: ['access', 'sharepoint'] },
  { key: 'hr', label: 'HR', match: ['hr'] },
  { key: 'safety', label: 'Safety', match: ['safety'] },
  { key: 'credentials', label: 'Credentials', match: ['credentials'] },
];
export function computeReadiness(workflow_id: number): { overall: string; categories: any[] } {
  const rows = getDb().prepare(`SELECT category, status FROM people_tasks WHERE workflow_id = ?`).all(workflow_id) as { category: string; status: string }[];
  const cats = READINESS_CATEGORIES.map((c) => {
    const mine = rows.filter((r) => c.match.includes(r.category));
    if (!mine.length) return { key: c.key, label: c.label, state: 'ready', open: 0, blocked: 0, total: 0 };
    const failed = mine.filter((r) => r.status === 'failed' || r.status === 'rejected').length;
    const blocked = mine.filter((r) => r.status === 'blocked').length;
    const open = mine.filter((r) => ['pending', 'awaiting_approval', 'blocked', 'in_progress', 'ready'].includes(r.status)).length;
    const state = failed ? 'blocked' : open ? 'at_risk' : 'ready';
    return { key: c.key, label: c.label, state, open, blocked, total: mine.length };
  });
  const overall = cats.some((c) => c.state === 'blocked') ? 'blocked' : cats.some((c) => c.state === 'at_risk') ? 'at_risk' : 'ready';
  return { overall, categories: cats };
}

/* ─────────────────────────── overview ─────────────────────────── */
export function overview(): any {
  const db = getDb();
  const n = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as { c: number }).c;
  return {
    onboarding: n(`SELECT COUNT(*) AS c FROM employees WHERE employment_status = 'onboarding'`),
    active: n(`SELECT COUNT(*) AS c FROM employees WHERE employment_status = 'active'`),
    offboarding: n(`SELECT COUNT(*) AS c FROM employees WHERE employment_status IN ('notice','offboarding')`),
    terminated: n(`SELECT COUNT(*) AS c FROM employees WHERE employment_status = 'terminated'`),
    openTasks: n(`SELECT COUNT(*) AS c FROM people_tasks WHERE status IN ('pending','ready','in_progress')`),
    awaitingApproval: n(`SELECT COUNT(*) AS c FROM people_tasks WHERE status = 'awaiting_approval'`),
    blocked: n(`SELECT COUNT(*) AS c FROM people_tasks WHERE status = 'blocked'`),
    positions: n(`SELECT COUNT(*) AS c FROM job_positions WHERE active = 1`),
    templatesUnreviewed: n(`SELECT COUNT(*) AS c FROM role_templates WHERE review_status = 'unreviewed'`),
  };
}

function displayName(h: NewHire): string {
  return h.preferred_name || [h.legal_first_name, h.legal_last_name].filter(Boolean).join(' ') || 'New hire';
}

const empName = (e: any): string => e.preferred_name || [e.legal_first_name, e.legal_last_name].filter(Boolean).join(' ') || `Employee ${e.id}`;

/** People "needs attention" counts — current employee risk, prioritized over configuration. */
export function peopleAttention(): any {
  const db = getDb();
  const n = (sql: string, ...a: any[]) => { try { return (db.prepare(sql).get(...a) as { c: number }).c || 0; } catch { return 0; } };
  return {
    startingSoon: n(`SELECT COUNT(*) c FROM employees WHERE employment_status='onboarding' AND anticipated_start_date IS NOT NULL AND julianday(anticipated_start_date)-julianday('now') BETWEEN -1 AND 7`),
    blockedOnboarding: n(`SELECT COUNT(DISTINCT w.employee_id) c FROM people_workflows w JOIN people_tasks t ON t.workflow_id=w.id WHERE w.kind='onboarding' AND w.status='open' AND t.status='blocked'`),
    missingCredentials: n(`SELECT COUNT(*) c FROM employee_credentials WHERE status IN ('required','expired')`),
    offboardingWithAccess: n(`SELECT COUNT(DISTINCT e.id) c FROM employees e JOIN employee_access a ON a.employee_id=e.id WHERE e.employment_status IN ('notice','offboarding','terminated') AND a.status IN ('provisioned','approved')`),
    unreturnedAssets: n(`SELECT COUNT(*) c FROM employee_assets a JOIN employees e ON e.id=a.employee_id WHERE e.employment_status IN ('notice','offboarding','terminated') AND a.status IN ('assigned','pending_return')`),
  };
}

/** Employees starting within `days`, each with their Day-1 readiness (most urgent first). */
export function startingSoon(days = 7): any[] {
  const db = getDb();
  const emps = db.prepare(
    `SELECT id, preferred_name, legal_first_name, legal_last_name, job_position, office, anticipated_start_date
       FROM employees WHERE employment_status='onboarding' AND anticipated_start_date IS NOT NULL
         AND julianday(anticipated_start_date)-julianday('now') BETWEEN -1 AND ?
      ORDER BY anticipated_start_date ASC`
  ).all(days) as any[];
  return emps.map((e) => {
    const wf = db.prepare(`SELECT id FROM people_workflows WHERE employee_id=? AND kind='onboarding' ORDER BY id DESC LIMIT 1`).get(e.id) as { id: number } | undefined;
    const readiness = wf ? computeReadiness(wf.id) : null;
    const d = Math.round((new Date(e.anticipated_start_date).getTime() - Date.now()) / 86400000);
    return { id: e.id, name: empName(e), job_position: e.job_position, office: e.office, start: e.anticipated_start_date, daysUntil: d, readiness: readiness ? readiness.overall : 'unknown', categories: readiness ? readiness.categories : [] };
  });
}

/** Assets by view: assigned | available | pending_return | missing. Office/employee context included. */
export function listAssets(view = 'assigned'): any[] {
  const db = getDb();
  let where = '1=1';
  if (view === 'assigned') where = `a.status='assigned'`;
  else if (view === 'available') where = `a.status='available' OR a.employee_id IS NULL`;
  else if (view === 'pending_return') where = `a.status='pending_return'`;
  else if (view === 'missing') where = `a.status IN ('missing','damaged')`;
  try {
    return (db.prepare(
      `SELECT a.id, a.asset_type, a.identifier, a.status, a.owner, a.assigned_at,
              e.id AS employee_id, e.preferred_name, e.legal_first_name, e.legal_last_name, e.office
         FROM employee_assets a LEFT JOIN employees e ON e.id=a.employee_id WHERE ${where}
        ORDER BY a.status, a.asset_type LIMIT 300`
    ).all() as any[]).map((a) => ({ id: a.id, type: a.asset_type, identifier: a.identifier, status: a.status, owner: a.owner, assigned_at: a.assigned_at, employee: a.employee_id ? empName(a) : null, office: a.office || null }));
  } catch { return []; }
}

/** Credentials by view: expiring | expired | missing | all. */
export function listCredentials(view = 'expiring'): any[] {
  const db = getDb();
  let where = '1=1';
  if (view === 'expiring') where = `c.expires_at IS NOT NULL AND julianday(c.expires_at)-julianday('now') BETWEEN 0 AND 60 AND c.status!='waived'`;
  else if (view === 'expired') where = `c.status='expired' OR (c.expires_at IS NOT NULL AND c.expires_at < date('now') AND c.status!='waived')`;
  else if (view === 'missing') where = `c.status='required'`;
  try {
    return (db.prepare(
      `SELECT c.id, c.credential_type, c.status, c.expires_at,
              e.id AS employee_id, e.preferred_name, e.legal_first_name, e.legal_last_name, e.office
         FROM employee_credentials c JOIN employees e ON e.id=c.employee_id WHERE ${where}
        ORDER BY (c.expires_at IS NULL), c.expires_at ASC LIMIT 300`
    ).all() as any[]).map((c) => ({ id: c.id, type: c.credential_type, status: c.status, expires_at: c.expires_at, employee: empName(c), office: c.office || null }));
  } catch { return []; }
}

/* ─────────────────────────── BambooHR roster import ─────────────────────────── */

/** The subset of employees columns a Bamboo row maps to, plus the status Bamboo reports. */
export interface MappedBambooEmployee {
  bamboo_id: string;
  employee_number: string | null;
  legal_first_name: string | null;
  legal_last_name: string | null;
  preferred_name: string | null;
  work_email: string | null;
  personal_email: string | null;
  personal_phone: string | null;
  office: string | null;
  department: string | null;
  public_job_title: string | null;
  job_position: string | null;
  manager: string | null;
  actual_start_date: string | null;
  bamboo_status: 'active' | 'terminated';
}

/**
 * Pure mapping from a raw BambooHR row to our employees columns. Returns null when the row has no
 * Bamboo id (we upsert by bamboo_id, so an id-less row can't be reconciled idempotently). BambooHR
 * marks former staff status='Inactive' (not 'Terminated') and returns a '0000-00-00' placeholder
 * hire date for some rows — both are handled here.
 */
export function mapBambooRow(row: BambooImportRow): MappedBambooEmployee | null {
  if (!row.id) return null;
  const cleanDate = (d: string | null): string | null => (d && d !== '0000-00-00' ? d : null);
  const s = String(row.status || '').toLowerCase();
  const bamboo_status: 'active' | 'terminated' = s === 'inactive' || s === 'terminated' ? 'terminated' : 'active';
  const title = row.jobTitle || null;
  return {
    bamboo_id: row.id,
    employee_number: row.employeeNumber,
    legal_first_name: row.firstName,
    legal_last_name: row.lastName,
    preferred_name: row.preferredName,
    work_email: row.workEmail,
    personal_email: row.homeEmail,
    personal_phone: row.mobilePhone,
    office: row.location,
    department: row.department,
    public_job_title: title,
    job_position: title, // seeds the role-template match; HR can correct it on review
    manager: row.supervisor,
    actual_start_date: cleanDate(row.hireDate),
    bamboo_status,
  };
}

// Statuses that reflect an in-flight lifecycle we own — never overwrite these from a Bamboo sync.
const IN_FLIGHT_STATUSES = new Set(['prehire', 'onboarding', 'notice', 'offboarding']);

export interface ImportResult {
  ok: boolean;
  reason?: string;
  total?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  active?: number;
  terminated?: number;
}

/**
 * Import (upsert) the real BambooHR roster into the employees table, keyed by bamboo_id so it is
 * idempotent and safe to re-run. Existing in-flight lifecycle statuses (onboarding/notice/offboarding)
 * are preserved; otherwise the employee's status follows Bamboo (Active→active, Inactive→terminated).
 * Returns an honest { ok:false, reason:'bamboo_not_connected' } when the API key is absent rather than
 * importing nothing silently.
 */
export async function importFromBamboo(actor: string): Promise<ImportResult> {
  if (!bambooConfigured()) return { ok: false, reason: 'bamboo_not_connected' };
  const rows = await fetchRosterForImport();
  if (rows === null) return { ok: false, reason: 'bamboo_fetch_failed' };

  const db = getDb();
  const findByBamboo = db.prepare(`SELECT id, employment_status FROM employees WHERE bamboo_id = ?`);
  const insert = db.prepare(
    `INSERT INTO employees (bamboo_id, employee_number, legal_first_name, legal_last_name, preferred_name,
        work_email, personal_email, personal_phone, office, department, public_job_title, job_position,
        manager, actual_start_date, employment_status, source)
     VALUES (@bamboo_id, @employee_number, @legal_first_name, @legal_last_name, @preferred_name,
        @work_email, @personal_email, @personal_phone, @office, @department, @public_job_title, @job_position,
        @manager, @actual_start_date, @employment_status, 'bamboo')`
  );
  const update = db.prepare(
    `UPDATE employees SET employee_number = @employee_number, legal_first_name = @legal_first_name,
        legal_last_name = @legal_last_name, preferred_name = @preferred_name, work_email = @work_email,
        personal_email = @personal_email, personal_phone = @personal_phone, office = @office,
        department = @department, public_job_title = @public_job_title, job_position = @job_position,
        manager = @manager, actual_start_date = @actual_start_date, employment_status = @employment_status,
        source = 'bamboo', updated_at = datetime('now')
     WHERE id = @id`
  );

  let created = 0, updated = 0, skipped = 0, active = 0, terminated = 0;
  const tx = db.transaction(() => {
    for (const raw of rows) {
      const m = mapBambooRow(raw);
      if (!m) { skipped++; continue; }
      if (m.bamboo_status === 'active') active++; else terminated++;
      const existing = findByBamboo.get(m.bamboo_id) as { id: number; employment_status: string } | undefined;
      if (existing) {
        // Keep an in-flight status we're managing; otherwise follow Bamboo.
        const status = IN_FLIGHT_STATUSES.has(existing.employment_status) ? existing.employment_status : m.bamboo_status;
        update.run({ ...m, id: existing.id, employment_status: status });
        updated++;
      } else {
        insert.run({ ...m, employment_status: m.bamboo_status });
        created++;
      }
    }
  });
  tx();

  audit('bamboo_import', `Imported ${rows.length} Bamboo rows: ${created} new, ${updated} updated, ${skipped} skipped (${active} active, ${terminated} inactive)`, { actor });
  return { ok: true, total: rows.length, created, updated, skipped, active, terminated };
}

/* ─────────────────────────── manual record edits (assets / access / credentials / notes) ───────────────────────────
 * Hand-entry alongside the automated onboarding routing and the RMM import. Every change is written
 * to the employee's history so the timeline stays the single source of truth. Callers are gated to
 * the right roles at the route; these functions assume authorization and just persist + audit. */

function employeeName(id: number): string {
  const e = getDb().prepare(`SELECT preferred_name, legal_first_name, legal_last_name FROM employees WHERE id = ?`).get(id) as any;
  if (!e) return `#${id}`;
  return `${e.preferred_name || e.legal_first_name || ''} ${e.legal_last_name || ''}`.trim() || `#${id}`;
}
function requireEmployee(id: number): void {
  const ok = getDb().prepare(`SELECT 1 FROM employees WHERE id = ?`).get(id);
  if (!ok) throw new Error('employee_not_found');
}

/* ---- Assets ---- */
export function addAsset(employee_id: number, input: { asset_type: string; identifier?: string; serial?: string; device_name?: string; owner?: string; status?: string; condition?: string; notes?: string }, actor: string) {
  requireEmployee(employee_id);
  const type = String(input.asset_type || '').trim();
  if (!type) throw new Error('asset_type_required');
  const status = input.status || 'assigned';
  const info = getDb().prepare(
    `INSERT INTO employee_assets (employee_id, asset_type, identifier, serial, device_name, status, owner, condition, notes, assigned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(employee_id, type, input.identifier || null, input.serial || null, input.device_name || null, status, input.owner || 'it', input.condition || null, input.notes || null, status === 'assigned' ? new Date().toISOString() : null);
  const label = `${type}${input.identifier ? ` (${input.identifier})` : input.serial ? ` (${input.serial})` : ''}`;
  audit('asset_added', `Assigned ${label}`, { actor, employee_id });
  return getDb().prepare(`SELECT * FROM employee_assets WHERE id = ?`).get(Number(info.lastInsertRowid));
}
export function updateAsset(id: number, patch: { status?: string; identifier?: string; serial?: string; device_name?: string; condition?: string; notes?: string; received_by?: string }, actor: string) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM employee_assets WHERE id = ?`).get(id) as any;
  if (!row) throw new Error('asset_not_found');
  const status = patch.status || row.status;
  const returnedAt = (status === 'returned' && row.status !== 'returned') ? new Date().toISOString() : row.returned_at;
  db.prepare(
    `UPDATE employee_assets SET status = ?, identifier = ?, serial = ?, device_name = ?, condition = ?, notes = ?, received_by = ?, returned_at = ? WHERE id = ?`
  ).run(
    status,
    patch.identifier ?? row.identifier,
    patch.serial ?? row.serial,
    patch.device_name ?? row.device_name,
    patch.condition ?? row.condition,
    patch.notes ?? row.notes,
    patch.received_by ?? row.received_by,
    returnedAt,
    id
  );
  if (patch.status && patch.status !== row.status) audit('asset_updated', `${row.asset_type} → ${status}`, { actor, employee_id: row.employee_id });
  return db.prepare(`SELECT * FROM employee_assets WHERE id = ?`).get(id);
}
export function removeAsset(id: number, actor: string) {
  const db = getDb();
  const row = db.prepare(`SELECT asset_type, employee_id FROM employee_assets WHERE id = ?`).get(id) as any;
  if (!row) throw new Error('asset_not_found');
  db.prepare(`DELETE FROM employee_assets WHERE id = ?`).run(id);
  audit('asset_removed', `Removed ${row.asset_type}`, { actor, employee_id: row.employee_id });
  return { ok: true };
}

/* ---- Access ---- */
export function addAccess(employee_id: number, input: { system: string; label?: string; access_level?: string; owner?: string; status?: string }, actor: string) {
  requireEmployee(employee_id);
  const system = String(input.system || '').trim();
  if (!system) throw new Error('system_required');
  const status = input.status || 'provisioned';
  const stamps: Record<string, string | null> = { approved_at: null, provisioned_at: null, revoked_at: null };
  const now = new Date().toISOString();
  if (status === 'approved') stamps.approved_at = now;
  if (status === 'provisioned') { stamps.approved_at = now; stamps.provisioned_at = now; }
  if (status === 'revoked') stamps.revoked_at = now;
  const info = getDb().prepare(
    `INSERT INTO employee_access (employee_id, system, label, access_level, status, owner, approved_at, provisioned_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(employee_id, system, input.label || system, input.access_level || null, status, input.owner || 'it', stamps.approved_at, stamps.provisioned_at, stamps.revoked_at);
  audit('access_added', `Granted ${input.label || system}`, { actor, employee_id });
  return getDb().prepare(`SELECT * FROM employee_access WHERE id = ?`).get(Number(info.lastInsertRowid));
}
export function updateAccessStatus(id: number, status: string, actor: string) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM employee_access WHERE id = ?`).get(id) as any;
  if (!row) throw new Error('access_not_found');
  const now = new Date().toISOString();
  const set: Record<string, string | null> = {};
  if (status === 'approved') set.approved_at = now;
  if (status === 'provisioned') set.provisioned_at = now;
  if (status === 'revoked') set.revoked_at = now;
  db.prepare(`UPDATE employee_access SET status = ?, approved_at = COALESCE(?, approved_at), provisioned_at = COALESCE(?, provisioned_at), revoked_at = COALESCE(?, revoked_at) WHERE id = ?`)
    .run(status, set.approved_at ?? null, set.provisioned_at ?? null, set.revoked_at ?? null, id);
  audit('access_updated', `${row.label || row.system} → ${status}`, { actor, employee_id: row.employee_id });
  return db.prepare(`SELECT * FROM employee_access WHERE id = ?`).get(id);
}
export function removeAccess(id: number, actor: string) {
  const db = getDb();
  const row = db.prepare(`SELECT system, label, employee_id FROM employee_access WHERE id = ?`).get(id) as any;
  if (!row) throw new Error('access_not_found');
  db.prepare(`DELETE FROM employee_access WHERE id = ?`).run(id);
  audit('access_removed', `Removed ${row.label || row.system}`, { actor, employee_id: row.employee_id });
  return { ok: true };
}

/* ---- Credentials ---- */
export function addCredential(employee_id: number, input: { credential_type: string; status?: string; expires_at?: string; notes?: string }, actor: string) {
  requireEmployee(employee_id);
  const type = String(input.credential_type || '').trim();
  if (!type) throw new Error('credential_type_required');
  const status = input.status || 'required';
  const info = getDb().prepare(
    `INSERT INTO employee_credentials (employee_id, credential_type, status, expires_at, notes, verified_at, verified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(employee_id, type, status, input.expires_at || null, input.notes || null, status === 'verified' ? new Date().toISOString() : null, status === 'verified' ? actor : null);
  audit('credential_added', `Added ${type}${input.expires_at ? ` (expires ${input.expires_at})` : ''}`, { actor, employee_id });
  return getDb().prepare(`SELECT * FROM employee_credentials WHERE id = ?`).get(Number(info.lastInsertRowid));
}
export function updateCredential(id: number, patch: { status?: string; expires_at?: string; notes?: string }, actor: string) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM employee_credentials WHERE id = ?`).get(id) as any;
  if (!row) throw new Error('credential_not_found');
  const status = patch.status || row.status;
  const verifiedAt = status === 'verified' ? (row.verified_at || new Date().toISOString()) : row.verified_at;
  const verifiedBy = status === 'verified' ? (row.verified_by || actor) : row.verified_by;
  db.prepare(`UPDATE employee_credentials SET status = ?, expires_at = ?, notes = ?, verified_at = ?, verified_by = ? WHERE id = ?`)
    .run(status, patch.expires_at ?? row.expires_at, patch.notes ?? row.notes, verifiedAt, verifiedBy, id);
  if (patch.status && patch.status !== row.status) audit('credential_updated', `${row.credential_type} → ${status}`, { actor, employee_id: row.employee_id });
  return db.prepare(`SELECT * FROM employee_credentials WHERE id = ?`).get(id);
}
export function removeCredential(id: number, actor: string) {
  const db = getDb();
  const row = db.prepare(`SELECT credential_type, employee_id FROM employee_credentials WHERE id = ?`).get(id) as any;
  if (!row) throw new Error('credential_not_found');
  db.prepare(`DELETE FROM employee_credentials WHERE id = ?`).run(id);
  audit('credential_removed', `Removed ${row.credential_type}`, { actor, employee_id: row.employee_id });
  return { ok: true };
}

/* ---- History note ---- */
export function addNote(employee_id: number, text: string, actor: string) {
  requireEmployee(employee_id);
  const note = String(text || '').trim();
  if (!note) throw new Error('note_required');
  audit('note', note, { actor, employee_id });
  return { ok: true };
}

/* ─────────────────────────── access provisioning to Microsoft 365 ───────────────────────────
 * Wires the Access tab to Entra: adding a security-group access grant actually adds the employee to
 * that Entra group via Graph, and revoking removes them. Keyless-safe: when Graph is not connected or
 * the employee has no directory identity, the grant is still recorded (status 'requested') with the
 * reason, so intent is never lost and IT can complete it once identity is in place. */

function employeeUpn(id: number): string | null {
  const e = getDb().prepare(`SELECT upn, work_email FROM employees WHERE id = ?`).get(id) as any;
  if (!e) return null;
  return (e.upn || e.work_email || null) as string | null;
}

/** The Entra security groups the OS knows about (from the onboarding catalog: printer + SharePoint
 *  groups carry a group_name/group_id). Used to populate the Access tab's group picker. */
export function listAccessGroups(): { name: string; id: string | null; kind: string }[] {
  try {
    const rows = getDb().prepare(
      `SELECT DISTINCT group_name AS name, group_id AS id, kind FROM onboarding_catalog
       WHERE active = 1 AND group_name IS NOT NULL AND group_name != '' ORDER BY group_name`
    ).all() as any[];
    return rows.map((r) => ({ name: r.name, id: r.id || null, kind: r.kind }));
  } catch {
    return [];
  }
}

export async function provisionAccessGroup(employee_id: number, input: { group_name: string; group_id?: string | null }, actor: string): Promise<{ ok: boolean; provisioned: boolean; message?: string; access?: any }> {
  requireEmployee(employee_id);
  const groupName = String(input.group_name || '').trim();
  if (!groupName) throw new Error('group_name_required');
  const db = getDb();
  const upn = employeeUpn(employee_id);
  let status = 'requested';
  let message: string | undefined;
  let provisioned = false;
  if (!graphConfigured()) {
    message = 'Recorded, but Microsoft 365 is not connected so the group membership was not applied.';
  } else if (!upn) {
    message = 'Recorded, but this employee has no work email / UPN on record, so the membership could not be applied. Add their work email and re-run.';
  } else {
    const out = await addUserToGroup(upn, { groupId: input.group_id, groupName });
    if (out.ok) { status = 'provisioned'; provisioned = true; message = out.already ? 'Already a member in Microsoft 365; recorded here.' : 'Added to the group in Microsoft 365.'; }
    else { status = 'requested'; message = `Recorded, but Microsoft 365 rejected it: ${out.error}`; }
  }
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO employee_access (employee_id, system, label, access_level, status, owner, external_ref, approved_at, provisioned_at)
     VALUES (?, ?, ?, 'member', ?, 'it', ?, ?, ?)`
  ).run(employee_id, groupName, `Security group: ${groupName}`, status, input.group_id || null, provisioned ? now : null, provisioned ? now : null);
  audit(provisioned ? 'access_provisioned' : 'access_requested', `${groupName}${provisioned ? ' (Entra)' : ''}`, { actor, employee_id });
  const access = db.prepare(`SELECT * FROM employee_access WHERE id = ?`).get(Number(info.lastInsertRowid));
  return { ok: true, provisioned, message, access };
}

export async function deprovisionAccessGroup(access_id: number, actor: string): Promise<{ ok: boolean; removed: boolean; message?: string }> {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM employee_access WHERE id = ?`).get(access_id) as any;
  if (!row) throw new Error('access_not_found');
  const upn = employeeUpn(row.employee_id);
  let removed = false;
  let message: string | undefined;
  if (!graphConfigured()) message = 'Marked revoked here, but Microsoft 365 is not connected so the group membership was not changed.';
  else if (!upn) message = 'Marked revoked here, but this employee has no work email / UPN, so the membership could not be changed in Microsoft 365.';
  else {
    const out = await removeUserFromGroup(upn, { groupId: row.external_ref, groupName: row.system });
    if (out.ok) { removed = true; message = out.already ? 'Was not a member in Microsoft 365; marked revoked.' : 'Removed from the group in Microsoft 365.'; }
    else message = `Marked revoked here, but Microsoft 365 rejected the removal: ${out.error}`;
  }
  db.prepare(`UPDATE employee_access SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?`).run(access_id);
  audit(removed ? 'access_deprovisioned' : 'access_revoked', `${row.label || row.system}${removed ? ' (Entra)' : ''}`, { actor, employee_id: row.employee_id });
  return { ok: true, removed, message };
}
