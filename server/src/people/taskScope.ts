import { AppUser, Role } from './authz';
import { itemDept } from '../services/offboardingAgent';

/**
 * Who sees which onboarding and offboarding tasks. One rule for both boards, enforced on the server:
 *
 *   People admin, Executive, Executive approver  everything
 *   HR          onboarding: BambooHR record + HR approvals      offboarding: HR
 *   IT          onboarding: IT, IT manager, ServiceTrade        offboarding: IT, IT manager devices, ServiceTrade
 *   Accounting  onboarding: Accounting approvals                offboarding: Accounting
 *   Safety      onboarding: Safety approvals                    offboarding: Safety
 *   Manager / Branch manager / Partner: only the approvals and steps addressed to them (their own hires
 *               and the people who report to them), never another manager's.
 *
 * A session with no Microsoft identity mapped to a role (the shared office password, or a Microsoft
 * account nobody has given a role) sees no tasks at all: there is no way to know whose department
 * they are in. A person with several roles sees the union.
 */
export const SEE_ALL: Role[] = ['people_admin', 'executive', 'executive_approver'];
const ONBOARDING: Partial<Record<Role, string[]>> = {
  hr: ['bamboo', 'sandi'],
  it: ['it', 'it_manager', 'laura'],
  accounting: ['rebecca'],
  safety: ['denise'],
  branch_manager: ['daniel'],
};
const OFFBOARDING: Partial<Record<Role, string[]>> = {
  hr: ['hr'],
  it: ['it', 'it_physical', 'servicetrade'],
  accounting: ['accounting'],
  safety: ['safety'],
};
const MANAGER_ROLES: Role[] = ['manager', 'branch_manager', 'partner'];

export interface TaskScope {
  all: boolean;            // sees every task
  signedIn: boolean;       // has a Microsoft identity with at least one role
  email: string | null;
  onboarding: Set<string>; // onboarding owner lanes
  offboarding: Set<string>;// offboarding departments
  ownApprovals: boolean;   // sees manager items addressed to their own email
}

export function taskScope(user: AppUser | null | undefined): TaskScope {
  const empty: TaskScope = { all: false, signedIn: false, email: null, onboarding: new Set(), offboarding: new Set(), ownApprovals: false };
  if (!user || !user.roles || !user.roles.length) return empty;
  const roles = user.roles;
  const email = String(user.email || '').toLowerCase();
  if (roles.some((r) => SEE_ALL.includes(r))) return { ...empty, all: true, signedIn: true, email };
  const on = new Set<string>(), off = new Set<string>();
  for (const r of roles) { (ONBOARDING[r] || []).forEach((o) => on.add(o)); (OFFBOARDING[r] || []).forEach((d) => off.add(d)); }
  return { all: false, signedIn: true, email, onboarding: on, offboarding: off, ownApprovals: roles.some((r) => MANAGER_ROLES.includes(r)) };
}

/** True when the scope shows nothing at all (no department and no manager approvals). */
export function seesNothing(s: TaskScope): boolean {
  return !s.all && !s.onboarding.size && !s.offboarding.size && !s.ownApprovals;
}

export function seesOnboardingItem(s: TaskScope, item: { owner: string; email_to?: string | null }): boolean {
  if (s.all) return true;
  if (item.owner === 'manager') return s.ownApprovals && !!s.email && String(item.email_to || '').toLowerCase() === s.email;
  return s.onboarding.has(item.owner);
}

export function seesOffboardingItem(s: TaskScope, item: { owner: string; email_to?: string | null; action_code?: string | null }, request: { manager_email?: string | null } | null): boolean {
  if (s.all) return true;
  const dept = itemDept(item);
  if (dept === 'manager') return s.ownApprovals && !!s.email && String((request && request.manager_email) || '').toLowerCase() === s.email;
  return s.offboarding.has(dept);
}

const TEAM_NAME: Partial<Record<Role, string>> = { hr: 'HR', it: 'IT', accounting: 'Accounting', safety: 'Safety', branch_manager: 'Branch manager' };

/** What this person is seeing, for the line at the top of the board. */
export function scopeSummary(s: TaskScope, user: AppUser | null | undefined): { all: boolean; signedIn: boolean; teams: string[] } {
  const roles = (user && user.roles) || [];
  const teams = [...new Set(roles.map((r) => TEAM_NAME[r]).filter(Boolean) as string[])];
  if (s.ownApprovals) teams.push('approvals addressed to you');
  return { all: s.all, signedIn: s.signedIn, teams };
}
