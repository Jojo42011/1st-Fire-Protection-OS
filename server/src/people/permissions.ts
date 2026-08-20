/**
 * Module x level permissions: the role matrix, made real.
 *
 * Each of the eleven roles has a documented preset level per module (0 none, 1 view, 2 view & edit).
 * A people_admin can override any role's levels; overrides persist in role_modules and overlay the
 * preset. A user's effective level for a module is the highest any of their roles grants, and a
 * people_admin always has edit. The matrix is the source of truth the Access screen reads and writes,
 * it is returned per-user on /api/me, and it is enforced where a module maps cleanly onto a gated
 * feature (compensation today; more as the whole app moves behind per-user identity).
 */
import { getDb } from '../db/index';
import { AppUser, Role } from './authz';

export type Level = 0 | 1 | 2; // none | view | view&edit

export const MODULES: { key: string; label: string }[] = [
  { key: 'overview', label: 'Overview & metrics' },
  { key: 'receivables', label: 'Receivables (AR)' },
  { key: 'deficiencies', label: 'Deficiencies & quotes' },
  { key: 'service', label: 'Jobs & service' },
  { key: 'people', label: 'People & employees' },
  { key: 'comp', label: 'Compensation & payroll' },
  { key: 'safety', label: 'Safety & fleet' },
  { key: 'accounting', label: 'Accounting & close' },
  { key: 'access', label: 'Access & roles' },
];
const MODULE_KEYS = new Set(MODULES.map((m) => m.key));

export const LEVELS: { value: Level; label: string }[] = [
  { value: 0, label: 'No access' },
  { value: 1, label: 'View' },
  { value: 2, label: 'View & edit' },
];

// The documented intent per role (matches the eleven authz.ts role keys). Overrides overlay these.
export const PRESETS: Record<string, Record<string, Level>> = {
  executive: { overview: 1, receivables: 1, deficiencies: 1, service: 1, people: 1, comp: 0, safety: 1, accounting: 1, access: 0 },
  partner: { overview: 1, receivables: 1, deficiencies: 2, service: 2, people: 1, comp: 0, safety: 1, accounting: 1, access: 0 },
  branch_manager: { overview: 1, receivables: 1, deficiencies: 2, service: 2, people: 1, comp: 0, safety: 1, accounting: 0, access: 0 },
  accounting: { overview: 1, receivables: 2, deficiencies: 1, service: 1, people: 0, comp: 0, safety: 0, accounting: 2, access: 0 },
  people_admin: { overview: 1, receivables: 1, deficiencies: 1, service: 1, people: 2, comp: 2, safety: 2, accounting: 1, access: 2 },
  hr: { overview: 0, receivables: 0, deficiencies: 0, service: 0, people: 2, comp: 2, safety: 1, accounting: 0, access: 0 },
  it: { overview: 0, receivables: 0, deficiencies: 0, service: 0, people: 1, comp: 0, safety: 0, accounting: 0, access: 2 },
  safety: { overview: 0, receivables: 0, deficiencies: 0, service: 1, people: 1, comp: 0, safety: 2, accounting: 0, access: 0 },
  executive_approver: { overview: 1, receivables: 1, deficiencies: 1, service: 1, people: 1, comp: 0, safety: 1, accounting: 1, access: 0 },
  manager: { overview: 1, receivables: 0, deficiencies: 1, service: 1, people: 1, comp: 0, safety: 0, accounting: 0, access: 0 },
  viewer: { overview: 1, receivables: 1, deficiencies: 1, service: 1, people: 1, comp: 0, safety: 1, accounting: 1, access: 0 },
};

function presetFor(role: string): Record<string, Level> {
  const p = PRESETS[role] || {};
  const out: Record<string, Level> = {};
  for (const m of MODULES) out[m.key] = (p[m.key] ?? 0) as Level;
  return out;
}

/** Saved overrides for a role, keyed by module. Falls back to none if the table is absent. */
function overridesFor(role: string): Record<string, Level> {
  const out: Record<string, Level> = {};
  try {
    const rows = getDb().prepare(`SELECT module, level FROM role_modules WHERE role = ?`).all(role) as { module: string; level: number }[];
    for (const r of rows) if (MODULE_KEYS.has(r.module)) out[r.module] = Math.max(0, Math.min(2, r.level)) as Level;
  } catch { /* table not created in this context: presets stand */ }
  return out;
}

/** The effective level map for one role: preset overlaid with saved overrides. */
export function levelsForRole(role: string): Record<string, Level> {
  return { ...presetFor(role), ...overridesFor(role) };
}

/** The whole matrix: every role's effective levels, plus which roles have a saved override. */
export function getMatrix(): { modules: typeof MODULES; levels: typeof LEVELS; roles: Record<string, { levels: Record<string, Level>; customized: boolean }> } {
  const roles: Record<string, { levels: Record<string, Level>; customized: boolean }> = {};
  for (const role of Object.keys(PRESETS)) {
    const ov = overridesFor(role);
    roles[role] = { levels: { ...presetFor(role), ...ov }, customized: Object.keys(ov).length > 0 };
  }
  return { modules: MODULES, levels: LEVELS, roles };
}

/** Save a role's per-module levels (people_admin only, enforced at the route). */
export function saveRoleLevels(role: string, levels: Record<string, number>, actor: string): Record<string, Level> {
  if (!PRESETS[role]) throw new Error('unknown_role');
  const db = getDb();
  const up = db.prepare(
    `INSERT INTO role_modules (role, module, level, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(role, module) DO UPDATE SET level = excluded.level, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  );
  const tx = db.transaction(() => {
    for (const m of MODULES) {
      if (levels[m.key] == null) continue;
      up.run(role, m.key, Math.max(0, Math.min(2, Number(levels[m.key]))), actor);
    }
  });
  tx();
  return levelsForRole(role);
}

/** Reset a role to its preset by clearing overrides. */
export function resetRoleLevels(role: string): Record<string, Level> {
  if (!PRESETS[role]) throw new Error('unknown_role');
  getDb().prepare(`DELETE FROM role_modules WHERE role = ?`).run(role);
  return presetFor(role);
}

/** A user's effective level for a module: the highest any of their roles grants. */
export function moduleLevel(user: AppUser | null | undefined, module: string): Level {
  if (!user) return 0;
  if (user.roles.includes('people_admin' as Role)) return 2; // super-user
  let lvl: Level = 0;
  for (const role of user.roles) {
    const l = levelsForRole(role)[module] ?? 0;
    if (l > lvl) lvl = l;
  }
  return lvl;
}

/** The signed-in user's effective level per module (for /api/me and the client). */
export function userModules(user: AppUser | null | undefined): Record<string, Level> {
  const out: Record<string, Level> = {};
  for (const m of MODULES) out[m.key] = moduleLevel(user, m.key);
  return out;
}

export function canAccessModule(user: AppUser | null | undefined, module: string, min: Level = 1): boolean {
  return moduleLevel(user, module) >= min;
}
