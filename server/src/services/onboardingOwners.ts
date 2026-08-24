import { getState, setState } from '../db/schema';
import { Owner } from './onboardingAgent';
import { AppUser, Role } from '../people/authz';

/**
 * Onboarding owner routing + visibility.
 *
 * Each onboarding lane (owner) maps to the People role that may SEE it and the email address its
 * tasks are routed to. This is what stops an HR-only person seeing the IT / accounting / owner lanes,
 * and what sends each lane's tasks to the right mailbox. People admins and executive approvers see
 * every lane; a legacy shared-password session (no People identity) also sees all, for back-compat.
 */

export const OWNER_ROLE: Record<Owner, Role | null> = {
  bamboo: 'hr',
  sandi: 'hr',
  it: 'it',
  rebecca: 'accounting',
  mario: 'executive_approver',
  denise: 'safety',
  daniel: 'branch_manager',
};

// Default task-routing addresses (a People admin can override per owner). Note the domain is
// 1stfpservices.com; correct any typo before relying on delivery.
const DEFAULT_EMAIL: Partial<Record<Owner, string>> = {
  bamboo: 'hr@1stfpservices.com',
  sandi: 'hr@1stfpservices.com',
  it: 'support@liontechlabs.com',
  rebecca: 'rebecca.koen@1stfpservices.com',
};

const K_EMAILS = 'onboarding_owner_emails';

/** The owner->email map: defaults overlaid with any admin overrides in system_state. */
export function ownerEmailMap(): Partial<Record<Owner, string>> {
  const merged: Partial<Record<Owner, string>> = { ...DEFAULT_EMAIL };
  try {
    const raw = getState(K_EMAILS);
    if (raw) { const o = JSON.parse(raw); if (o && typeof o === 'object') Object.assign(merged, o); }
  } catch { /* ignore */ }
  return merged;
}

export function setOwnerEmail(owner: Owner, email: string | null): Partial<Record<Owner, string>> {
  const raw = getState(K_EMAILS);
  let o: Record<string, string> = {};
  if (raw) { try { o = JSON.parse(raw) || {}; } catch { o = {}; } }
  if (email && email.trim()) o[owner] = email.trim(); else delete o[owner];
  setState(K_EMAILS, JSON.stringify(o));
  return ownerEmailMap();
}

/** The set of owner lanes a user may see, or null for "all" (admin, executive approver, or a legacy
 *  session with no People roles). */
export function visibleOwners(user: AppUser | null | undefined): Set<Owner> | null {
  if (!user || !user.roles || user.roles.length === 0) return null; // legacy/shared-password: unchanged
  const roles = new Set<Role>(user.roles);
  if (roles.has('people_admin') || roles.has('executive_approver')) return null; // super-users see all
  const set = new Set<Owner>();
  for (const owner of Object.keys(OWNER_ROLE) as Owner[]) {
    const need = OWNER_ROLE[owner];
    if (need && roles.has(need)) set.add(owner);
  }
  return set;
}

/* ─────────────────────────── task routing (email) ─────────────────────────── */
import { sendMail, mailCredsPresent } from './msGraphMail';
import { senderFor } from './mailSenders';
import { OnboardingItem } from './onboardingAgent';

const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ownerTasksHtml(hireName: string, items: OnboardingItem[], boardUrl: string): string {
  const rows = items.map((it) => `<tr><td style="padding:8px 10px;border-bottom:1px solid #E7E6E1">${esc(it.label)}${it.detail ? `<div style="color:#667085;font-size:12px">${esc(it.detail)}</div>` : ''}</td><td style="padding:8px 10px;border-bottom:1px solid #E7E6E1;color:#667085;font-size:12px;white-space:nowrap">${esc(it.kind)}</td></tr>`).join('');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#101828;max-width:560px">
    <p>New-hire onboarding for <b>${esc(hireName)}</b> has tasks for your team:</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${rows}</tbody></table>
    <p style="margin-top:16px"><a href="${esc(boardUrl)}" style="background:#101828;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;display:inline-block">Open the onboarding board</a></p>
    <p style="color:#667085;font-size:12px">You are receiving this because your team is the routing target for these onboarding tasks. Nothing provisions automatically: each item waits for the owner to act.</p>
  </div>`;
}

/** Email each owner lane's tasks to its routed address (hr@, IT MSP, accounting). Best-effort and
 *  keyless-safe: a no-op when mail is not connected or no owner has a mapped address. */
export async function notifyOwners(request: any, items: OnboardingItem[], base: string): Promise<{ sent: number }> {
  if (!mailCredsPresent()) return { sent: 0 };
  const sender = senderFor('onboarding');
  if (!sender) return { sent: 0 };
  const map = ownerEmailMap();
  const byEmail = new Map<string, OnboardingItem[]>();
  for (const it of items) {
    const email = map[it.owner as Owner];
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email)!.push(it);
  }
  if (!byEmail.size) return { sent: 0 };
  const boardUrl = `${base}/onboarding`;
  let sent = 0;
  for (const [email, its] of byEmail) {
    const html = ownerTasksHtml(request.name, its, boardUrl);
    // eslint-disable-next-line no-await-in-loop
    const out = await sendMail(email, `Onboarding tasks for ${request.name}`, html, { from: sender.address, fromName: sender.name });
    if (out.ok) sent++;
  }
  return { sent };
}
