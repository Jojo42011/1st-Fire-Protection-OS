/**
 * People / Employee Lifecycle — authorization (centralized, server-enforced).
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
  | 'people_admin'   // administers People: users/roles, templates, catalogs (super-user)
  | 'hr'             // HR: BambooHR, payroll, benefits, comp visibility, Payroll/HR SharePoint approval
  | 'it'             // IT: identity, hardware, software, access provisioning
  | 'safety'         // Safety: MVR, vehicles, WEX, fleet, safety onboarding
  | 'accounting'     // Accounting: ACCT SharePoint approval, accounting-restricted access
  | 'executive_approver' // Mario OR Chris: MGMT SharePoint, high-cost/sensitive exceptions
  | 'manager'        // hiring managers: initiate onboarding, submit intake for their hires
  | 'viewer';        // read-only

export const ROLES: { key: Role; label: string; description: string }[] = [
  { key: 'people_admin', label: 'People Admin', description: 'Administers users, roles, templates, and catalogs' },
  { key: 'hr', label: 'HR', description: 'BambooHR, payroll, benefits, compensation, HR/Payroll approvals' },
  { key: 'it', label: 'IT', description: 'Identity, hardware, software, and access provisioning' },
  { key: 'safety', label: 'Safety', description: 'MVR, vehicles, WEX, fleet, safety onboarding' },
  { key: 'accounting', label: 'Accounting', description: 'Accounting-restricted access and ACCT approvals' },
  { key: 'executive_approver', label: 'Executive Approver', description: 'MGMT access and high-cost exceptions (Mario or Chris)' },
  { key: 'manager', label: 'Manager', description: 'Initiates onboarding and submits intake for their hires' },
  { key: 'viewer', label: 'Viewer', description: 'Read-only access to People' },
];
const ROLE_SET = new Set<Role>(ROLES.map((r) => r.key));

export interface AppUser {
  email: string;
  display_name: string | null;
  roles: Role[];
  active: boolean;
  source: string;
}

/** The current signed-in user with their mapped roles, or null when unauthenticated. */
export function currentUser(req: express.Request): AppUser | null {
  const id: Identity | null = currentIdentity(req);
  if (!id || !id.email) return null;
  const email = id.email.toLowerCase();
  const row = getDb()
    .prepare(`SELECT email, display_name, roles, active, source FROM app_users WHERE lower(email) = ?`)
    .get(email) as { email: string; display_name: string | null; roles: string | null; active: number; source: string } | undefined;

  // A configured bootstrap email is always a people_admin, so the very first admin can sign in
  // and assign everyone else. Honest and explicit — set via PEOPLE_BOOTSTRAP_EMAIL.
  const bootstrap = (process.env.PEOPLE_BOOTSTRAP_EMAIL || '').toLowerCase();
  const isBootstrap = bootstrap && bootstrap === email;

  if (!row && !isBootstrap) return null;         // authenticated to Entra, but not authorized for People
  if (row && row.active === 0 && !isBootstrap) return null;

  const roles = new Set<Role>(parseRoles(row?.roles));
  if (isBootstrap) roles.add('people_admin');
  return { email, display_name: row?.display_name || id.name || null, roles: [...roles], active: true, source: row?.source || 'bootstrap' };
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
/** Compensation/pay data is HR-only (plus people_admin). Managers/IT/etc. must not see salary. */
export function canViewCompensation(user: AppUser | null): boolean {
  return hasRole(user, 'hr');
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
  const rows = getDb().prepare(`SELECT email, display_name, roles, active, source FROM app_users ORDER BY email`).all() as any[];
  return rows.map((r) => ({ email: r.email, display_name: r.display_name, roles: parseRoles(r.roles), active: r.active === 1, source: r.source }));
}
export function upsertAppUser(email: string, roles: Role[], displayName?: string | null): AppUser {
  const clean = [...new Set(roles.filter((r) => ROLE_SET.has(r)))];
  getDb()
    .prepare(
      `INSERT INTO app_users (email, display_name, roles, active, source) VALUES (?, ?, ?, 1, 'admin')
       ON CONFLICT(email) DO UPDATE SET roles = excluded.roles, display_name = COALESCE(excluded.display_name, app_users.display_name)`
    )
    .run(email.toLowerCase(), displayName ?? null, clean.join(','));
  return { email: email.toLowerCase(), display_name: displayName ?? null, roles: clean, active: true, source: 'admin' };
}
export function setAppUserActive(email: string, active: boolean): void {
  getDb().prepare(`UPDATE app_users SET active = ? WHERE lower(email) = ?`).run(active ? 1 : 0, email.toLowerCase());
}
