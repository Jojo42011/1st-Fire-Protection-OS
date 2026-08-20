/**
 * People / Employee Lifecycle - authorization (centralized, server-enforced).
 *
 * The shared APP_PASSWORD gate is NOT sufficient for HR/employee data: knowing the office
 * password must not grant access to People. Access here requires a real identity (see
 * identity.ts, Microsoft Entra when configured) whose email is mapped to one or more app roles
 * in the `app_users` table. The mapping lives in ONE place (the DB, seeded from a bootstrap +
 * editable by a people_admin) so route files never hard-code email addresses.
 *
 * The server enforces every check. Hiding buttons in the UI is a convenience, never the control.
 */
import express from 'express';
import { getDb } from '../db/index';
import { currentIdentity, Identity } from './identity';

export type Role =
  // ── OS operating roles (office-scoped business access) ──
  | 'executive'      // HQ/exec: company-wide operating + financial visibility
  | 'partner'        // office partner/owner: their office's operating + financial views
  | 'branch_manager' // runs an office day to day: jobs, service, backlog, people readiness
  | 'accounting'     // Accounting: AR, handoffs, close, ACCT approvals
  // ── People / Employee Lifecycle roles ──
  | 'people_admin'   // administers People: users/roles, templates, catalogs (super-user)
  | 'hr'             // HR: BambooHR, payroll, benefits, comp visibility, Payroll/HR SharePoint approval
  | 'it'             // IT: identity, hardware, software, access provisioning
  | 'safety'         // Safety: MVR, vehicles, WEX, fleet, safety onboarding
  | 'executive_approver' // Mario OR Chris: MGMT SharePoint, high-cost/sensitive exceptions
  | 'manager'        // hiring managers: initiate onboarding, submit intake for their hires
  | 'viewer';        // read-only

export const ROLES: { key: Role; label: string; description: string }[] = [
  { key: 'executive', label: 'Executive', description: 'Company-wide operating and financial visibility (HQ)' },
  { key: 'partner', label: 'Partner', description: "An office partner/owner: their office's operating and financial views" },
  { key: 'branch_manager', label: 'Branch Manager', description: 'Runs an office: jobs, service, backlog, people readiness' },
  { key: 'people_admin', label: 'People Admin', description: 'Administers users, roles, templates, and catalogs' },
  { key: 'hr', label: 'HR', description: 'BambooHR, payroll, benefits, compensation, HR/Payroll approvals' },
  { key: 'it', label: 'IT', description: 'Identity, hardware, software, and access provisioning' },
  { key: 'safety', label: 'Safety', description: 'MVR, vehicles, WEX, fleet, safety onboarding' },
  { key: 'accounting', label: 'Accounting', description: 'AR, accounting handoffs, close, and ACCT approvals' },
  { key: 'executive_approver', label: 'Executive Approver', description: 'MGMT access and high-cost exceptions (Mario or Chris)' },
  { key: 'manager', label: 'Manager', description: 'Initiates onboarding and submits intake for their hires' },
  { key: 'viewer', label: 'Viewer', description: 'Read-only access' },
];
const ROLE_SET = new Set<Role>(ROLES.map((r) => r.key));

export interface AppUser {
  email: string;
  display_name: string | null;
  roles: Role[];
  active: boolean;
  source: string;
  offices: string[];    // canonical office keys this user is authorized for
  all_offices: boolean; // company-wide office scope
}

/** The current signed-in user with their mapped roles, or null when unauthenticated. */
export function currentUser(req: express.Request): AppUser | null {
  const id: Identity | null = currentIdentity(req);
  if (!id || !id.email) return null;
  const email = id.email.toLowerCase();
  const row = getDb()
    .prepare(`SELECT email, display_name, roles, active, source, offices, all_offices FROM app_users WHERE lower(email) = ?`)
    .get(email) as
    | { email: string; display_name: string | null; roles: string | null; active: number; source: string; offices: string | null; all_offices: number }
    | undefined;

  // A configured bootstrap email is always a people_admin, so the very first admin can sign in
  // and assign everyone else. Honest and explicit - set via PEOPLE_BOOTSTRAP_EMAIL.
  const bootstrap = (process.env.PEOPLE_BOOTSTRAP_EMAIL || '').toLowerCase();
  const isBootstrap = bootstrap && bootstrap === email;

  if (!row && !isBootstrap) return null;         // authenticated to Entra, but not authorized for People
  if (row && row.active === 0 && !isBootstrap) return null;

  const roles = new Set<Role>(parseRoles(row?.roles));
  if (isBootstrap) roles.add('people_admin');
  // Bootstrap and any people_admin/executive gets company-wide office scope so the first admin is
  // never locked out; otherwise office scope comes only from the explicit grant.
  const wideByRole = roles.has('people_admin') || roles.has('executive');
  const all_offices = isBootstrap || wideByRole || row?.all_offices === 1;
  const offices = parseOffices(row?.offices);
  return {
    email,
    display_name: row?.display_name || id.name || null,
    roles: [...roles],
    active: true,
    source: row?.source || 'bootstrap',
    offices,
    all_offices,
  };
}

/** Parse the CSV of canonical office keys stored on app_users.offices. */
function parseOffices(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return [...new Set(csv.split(',').map((o) => o.trim().toLowerCase()).filter(Boolean))];
}

function parseRoles(csv: string | null | undefined): Role[] {
  if (!csv) return [];
  return csv.split(',').map((r) => r.trim()).filter((r): r is Role => ROLE_SET.has(r as Role));
}

/* ─────────────────────────── permission predicates ─────────────────────────── */
export function hasRole(user: AppUser | null, ...roles: Role[]): boolean {
  if (!user) return false;
  if (user.roles.includes('people_admin')) return true; // super-user
  return roles.some((r) => user.roles.includes(r));
}
/** Any People access at all (read). Every listed role plus viewer may look. */
export function hasAnyPeopleRole(user: AppUser | null): boolean {
  return !!user && user.roles.length > 0;
}
/**
 * Compensation/pay data visibility is driven by the Access matrix's "comp" module (view or higher):
 * HR and people_admin by preset, and anything an admin grants there. Enforced on every request that
 * returns pay, so the matrix is a real control, not documentation.
 */
export function canViewCompensation(user: AppUser | null): boolean {
  // Lazy require avoids a load-time cycle (permissions type-imports authz).
  const { moduleLevel } = require('./permissions') as typeof import('./permissions');
  return moduleLevel(user, 'comp') >= 1;
}
/** Can this user satisfy an approval addressed to `approverRole`? The mapped role, or admin. */
export function canApprove(user: AppUser | null, approverRole: string): boolean {
  if (!user) return false;
  if (user.roles.includes('people_admin')) return true;
  return user.roles.includes(approverRole as Role);
}

/* ─────────────────────────── middleware ─────────────────────────── */
/** 401 if not signed in / not authorized for People; else attaches req.user. */
export function requirePeople(...roles: Role[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'people_auth_required', entra: currentIdentity(req) ? 'authenticated_unauthorized' : 'sign_in_required' });
      return;
    }
    if (roles.length && !hasRole(user, ...roles)) {
      res.status(403).json({ ok: false, error: 'forbidden', need: roles });
      return;
    }
    (req as any).user = user;
    next();
  };
}

/* ─────────────────────────── app_users management ─────────────────────────── */
export function listAppUsers(): AppUser[] {
  const rows = getDb().prepare(`SELECT email, display_name, roles, active, source, offices, all_offices FROM app_users ORDER BY email`).all() as any[];
  return rows.map((r) => ({
    email: r.email,
    display_name: r.display_name,
    roles: parseRoles(r.roles),
    active: r.active === 1,
    source: r.source,
    offices: parseOffices(r.offices),
    all_offices: r.all_offices === 1,
  }));
}
export function upsertAppUser(
  email: string,
  roles: Role[],
  displayName?: string | null,
  scope?: { offices?: string[]; all_offices?: boolean }
): AppUser {
  const clean = [...new Set(roles.filter((r) => ROLE_SET.has(r)))];
  const offices = [...new Set((scope?.offices || []).map((o) => o.trim().toLowerCase()).filter(Boolean))];
  const allOffices = scope?.all_offices ? 1 : 0;
  getDb()
    .prepare(
      `INSERT INTO app_users (email, display_name, roles, active, source, offices, all_offices) VALUES (?, ?, ?, 1, 'admin', ?, ?)
       ON CONFLICT(email) DO UPDATE SET roles = excluded.roles,
         display_name = COALESCE(excluded.display_name, app_users.display_name),
         offices = excluded.offices, all_offices = excluded.all_offices`
    )
    .run(email.toLowerCase(), displayName ?? null, clean.join(','), offices.join(','), allOffices);
  return { email: email.toLowerCase(), display_name: displayName ?? null, roles: clean, active: true, source: 'admin', offices, all_offices: !!allOffices };
}
export function setAppUserActive(email: string, active: boolean): void {
  getDb().prepare(`UPDATE app_users SET active = ? WHERE lower(email) = ?`).run(active ? 1 : 0, email.toLowerCase());
}

/**
 * Make the configured bootstrap admin a real, durable row (not just an env-based grant), so the
 * first admin is concrete, appears in Access & roles, and survives even if the env var is later
 * changed. Idempotent: only ensures the people_admin role and company-wide scope are present, and
 * never downgrades or deactivates an existing row.
 */
export function ensureBootstrapAdmin(): void {
  const email = (process.env.PEOPLE_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  if (!email) return;
  const db = getDb();
  const row = db.prepare(`SELECT roles, all_offices, active FROM app_users WHERE lower(email) = ?`).get(email) as
    | { roles: string | null; all_offices: number; active: number }
    | undefined;
  const roles = new Set<Role>(parseRoles(row?.roles));
  roles.add('people_admin');
  db.prepare(
    `INSERT INTO app_users (email, display_name, roles, active, source, offices, all_offices)
       VALUES (?, ?, ?, 1, 'bootstrap', '', 1)
     ON CONFLICT(email) DO UPDATE SET roles = excluded.roles, all_offices = 1, active = 1`
  ).run(email, 'Bootstrap Admin', [...roles].join(','));
}
