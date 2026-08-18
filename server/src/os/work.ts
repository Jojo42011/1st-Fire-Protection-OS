/**
 * Unified Work / My Tasks service.
 *
 * One normalized task view over multiple domains — People lifecycle tasks and exception remediation
 * today, operational workflows later — so Work > My Tasks is an execution inbox, not N divergent
 * task systems. This is an AGGREGATION layer: it reads the existing people_tasks and exceptions
 * tables and normalizes them; it does not migrate or collapse those tables.
 *
 * Every row is office-scoped server-side: People tasks by their employee's office, exceptions by
 * their own office (plus company-wide). A "mine" filter narrows to the caller's assigned tasks.
 */
import { getDb } from '../db/index';
import { OsContext, officeScopeClause } from './scope';
import { canonicalOffice, officeLabel } from './office';
import { listExceptions } from './exceptions';

export interface WorkTask {
  id: string;                 // "people:123" | "exception:45"
  source: 'people' | 'exception';
  subject: string;
  detail?: string;
  office: string | null;
  officeLabel: string;
  ownerTeam: string | null;
  assignedUser: string | null;
  dueDate: string | null;
  status: string;
  blocked: boolean;
  blockedReason?: string;
  related: { tab: string; office: string | null; label: string } | null;
  nextAction: string;
  group: 'needs_you' | 'overdue' | 'blocked' | 'upcoming' | 'completed';
}

const OPEN_PEOPLE = ['pending', 'ready', 'in_progress', 'awaiting_approval', 'blocked'];
const EXC_CATEGORY_TAB: Record<string, string> = {
  deficiency_aging: 'deficiencies', terminated_access: 'people', ar_aging: 'receivables',
  handoff_missing_office: 'jobs', handoff_missing_contact: 'jobs',
};

function todayISO(): string { return new Date().toISOString().slice(0, 10); }

function groupOf(status: string, dueDate: string | null, blocked: boolean, completedRecently: boolean): WorkTask['group'] {
  if (completedRecently) return 'completed';
  if (blocked) return 'blocked';
  if (dueDate && dueDate < todayISO()) return 'overdue';
  if (dueDate && dueDate > todayISO()) return 'upcoming';
  return 'needs_you';
}

/** All work for the caller's scope, normalized + grouped. filter: { mine, team, group }. */
export function listWork(ctx: OsContext, filter: { mine?: boolean; team?: string; group?: string } = {}): WorkTask[] {
  const db = getDb();
  const tasks: WorkTask[] = [];

  // ── People lifecycle tasks (open), scoped by the employee's office ──
  try {
    const scope = officeScopeClause('e.office', ctx, ctx.allOffices ? 'all' : '__scoped__');
    const rows = db.prepare(
      `SELECT t.id, t.team, t.title, t.detail, t.status, t.due_date, t.assigned_user, t.depends_on_key,
              t.employee_id, e.office AS emp_office, e.preferred_name, e.legal_first_name, e.legal_last_name
         FROM people_tasks t JOIN employees e ON e.id = t.employee_id
        WHERE t.status IN (${OPEN_PEOPLE.map(() => '?').join(',')}) AND (${scope.sql})`
    ).all(...OPEN_PEOPLE, ...scope.params) as any[];
    for (const r of rows) {
      const name = r.preferred_name || [r.legal_first_name, r.legal_last_name].filter(Boolean).join(' ') || `Employee ${r.employee_id}`;
      const key = canonicalOffice(r.emp_office) || null;
      const blocked = r.status === 'blocked' || r.status === 'awaiting_approval';
      tasks.push({
        id: `people:${r.id}`, source: 'people', subject: r.title, detail: `${name}${r.detail ? ' · ' + r.detail : ''}`,
        office: key, officeLabel: key ? officeLabel(key) : 'Unassigned', ownerTeam: r.team, assignedUser: r.assigned_user,
        dueDate: r.due_date || null, status: r.status, blocked, blockedReason: blocked ? (r.status === 'awaiting_approval' ? 'Waiting on approval' : 'Blocked by a dependency') : undefined,
        related: { tab: 'people', office: null, label: name },
        nextAction: r.status === 'awaiting_approval' ? 'Awaiting approval' : 'Complete',
        group: groupOf(r.status, r.due_date, blocked, false),
      });
    }
  } catch { /* people_tasks/employees may be empty */ }

  // ── Exception remediation (open), already office-scoped by listExceptions ──
  try {
    for (const e of listExceptions(ctx, { status: 'open' })) {
      const blocked = e.status === 'blocked';
      tasks.push({
        id: `exception:${e.id}`, source: 'exception', subject: e.title, detail: e.description,
        office: e.office, officeLabel: e.officeLabel, ownerTeam: e.owner_team, assignedUser: e.assigned_user,
        dueDate: e.due_at || null, status: e.status, blocked,
        related: { tab: EXC_CATEGORY_TAB[e.category] || 'exceptions', office: e.office, label: e.category.replace(/_/g, ' ') },
        nextAction: 'Resolve',
        group: groupOf(e.status, e.due_at, blocked, false),
      });
    }
  } catch { /* exceptions may be empty */ }

  let out = tasks;
  if (filter.mine && ctx.email) out = out.filter((t) => (t.assignedUser || '').toLowerCase() === ctx.email!.toLowerCase());
  if (filter.team) out = out.filter((t) => t.ownerTeam === filter.team);
  if (filter.group) out = out.filter((t) => t.group === filter.group);

  // Order: overdue, needs_you, blocked, upcoming, completed
  const order = { overdue: 0, needs_you: 1, blocked: 2, upcoming: 3, completed: 4 };
  out.sort((a, b) => (order[a.group] - order[b.group]) || ((a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1));
  return out;
}

export function workSummary(ctx: OsContext, filter: { mine?: boolean; team?: string } = {}): any {
  const all = listWork(ctx, filter);
  const by: Record<string, number> = { needs_you: 0, overdue: 0, blocked: 0, upcoming: 0, completed: 0 };
  for (const t of all) by[t.group]++;
  return { total: all.length, groups: by };
}
