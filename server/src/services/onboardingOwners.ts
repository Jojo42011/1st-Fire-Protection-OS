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
  it_manager: 'it', // MGMT and paid-license approvals (and computers with no manager on file): routed to the IT manager by email
  manager: 'manager', // new-computer approvals: each one emailed to that hire's own manager (item email_to)
  rebecca: 'accounting',
  mario: 'executive_approver',
  denise: 'safety',
  daniel: 'branch_manager',
  laura: 'it', // ServiceTrade provisioning: visible to IT; routed to Laura by email
};

// Default task-routing addresses (a People admin can override per owner). Note the domain is
// 1stfpservices.com; correct any typo before relying on delivery.
const DEFAULT_EMAIL: Partial<Record<Owner, string>> = {
  bamboo: 'hr@1stfpservices.com',
  sandi: 'hr@1stfpservices.com',
  it: 'support@liontechlabs.com',
  it_manager: 'devon.booker@1stfpservices.com',
  rebecca: 'rebecca.koen@1stfpservices.com',
  denise: 'safety@1stfpservices.com',
  laura: 'laura.shannon@1stfpservices.com',
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

export interface StartDateInfo { long: string; short: string; relative: string | null }

/** Today's date in Central time (every office is in Texas), as YYYY-MM-DD. */
function centralToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The hire's start date for the task emails: "Monday, October 6, 2026" / "Mon Oct 6" plus how far
 *  away it is, so the team can see the deadline at a glance. Null when no start date was given. */
export function startDateInfo(raw: string | null | undefined, now = new Date()): StartDateInfo | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return { long: v, short: v, relative: null };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  if (isNaN(d.getTime())) return { long: v, short: v, relative: null };
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(d);
  const t = centralToday(now).split('-').map(Number);
  const days = Math.round((d.getTime() - Date.UTC(t[0], t[1] - 1, t[2], 12)) / 86400000);
  const relative = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday'
    : days > 1 ? `in ${days} days` : `${-days} days ago`;
  return {
    long: fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    short: fmt({ weekday: 'short', month: 'short', day: 'numeric' }),
    relative,
  };
}

function startLineHtml(start: StartDateInfo | null): string {
  if (!start) return `<p style="margin:0 0 14px;padding:10px 12px;background:#FFF7E6;border-radius:8px;color:#8A5A00;font-size:14px"><b>Start date:</b> not provided yet. Check with HR before scheduling the work.</p>`;
  return `<p style="margin:0 0 14px;padding:10px 12px;background:#F2F5F9;border-radius:8px;font-size:14px"><b>Start date:</b> ${esc(start.long)}${start.relative ? ` <span style="color:#667085">(${esc(start.relative)})</span>` : ''}. Please have these done before their first day.</p>`;
}

/** Subject for a lane's email, carrying the start date so it is visible in the inbox list. */
function ownerSubject(hireName: string, start: StartDateInfo | null, ownerLabel?: string): string {
  return `Onboarding tasks for ${hireName}${start ? ` (starts ${start.short})` : ''}${ownerLabel ? `: ${ownerLabel}` : ''}`;
}

/** "Due Mon, Oct 5" / "Due today" / "Overdue (Fri, Oct 2)" for one item. */
export function dueLabel(dueAt: string | null | undefined, now = new Date()): { text: string; late: boolean } | null {
  const d = startDateInfo(dueAt, now);
  if (!d || !d.relative) return null;
  if (/ago$|^yesterday$/.test(d.relative)) return { text: `Overdue (${d.short})`, late: true };
  return { text: d.relative === 'today' ? 'Due today' : `Due ${d.short}`, late: false };
}

/** Who an item's email goes to: its own recipient (a hire's manager) when set, else its lane address. */
export function recipientFor(it: { owner: string; email_to?: string | null }, map: Partial<Record<Owner, string>> = ownerEmailMap()): string | null {
  return (it.email_to && it.email_to.trim()) || map[it.owner as Owner] || null;
}

/** Approve/Reject link for an approval sent to `email`, so they can decide without signing in. */
function approveButton(it: OnboardingItem, email: string | null, base: string): string {
  if (it.kind !== 'approval' || it.status !== 'pending' || !email) return '';
  return `<div style="margin-top:8px"><a href="${esc(approvalUrl(base, it.id, email))}" style="background:#101828;color:#fff;text-decoration:none;padding:7px 12px;border-radius:7px;font-size:13px;display:inline-block">Review and approve</a></div>`;
}

/** Recipients who do not sign in to the OS (ServiceTrade's Laura): no "Open the board" button for them. */
function showsBoard(email: string | null | undefined, map: Partial<Record<Owner, string>> = ownerEmailMap()): boolean {
  const e = String(email || '').toLowerCase();
  return !(e && map.laura && e === map.laura.toLowerCase());
}

/** The hiring manager line IT support sees on a hire's tasks, so they know who to coordinate with. */
export interface HiringManager { name: string | null; email: string | null }
const flipName = (n: string) => (n.includes(',') ? `${n.split(',').slice(1).join(',').trim()} ${n.split(',')[0].trim()}`.trim() : n.trim());
export function hiringManagerFor(request: { id?: number; employee_id?: number | null; manager_name?: string | null }): HiringManager | null {
  const m = resolveHireManager(request);
  const email = m.email || (request.id ? managerEmailFor(request.id) : null);
  if (!m.name && !email) return null;
  return { name: m.name ? flipName(m.name) : null, email };
}
function hiringManagerHtml(hm: HiringManager | null): string {
  const who = hm ? [hm.name ? esc(hm.name) : '', hm.email ? `<a href="mailto:${esc(hm.email)}" style="color:#101828">${esc(hm.email)}</a>` : ''].filter(Boolean).join(hm.name && hm.email ? ' &middot; ' : '') : '';
  return `<p style="margin:-6px 0 14px;padding:10px 12px;background:#F2F5F9;border-radius:8px;font-size:14px"><b>Hiring manager:</b> ${who || '<span style="color:#8A5A00">not on file yet</span>'}</p>`;
}
/** IT support (the "it" lane address) gets the hiring manager on every email about a hire. */
function wantsManager(email: string | null | undefined, map: Partial<Record<Owner, string>> = ownerEmailMap()): boolean {
  return !!email && !!map.it && email.toLowerCase() === map.it.toLowerCase();
}

function ownerTasksHtml(hireName: string, items: OnboardingItem[], boardUrl: string, start: StartDateInfo | null, intro?: string, approver?: { email: string; base: string }, extra: { manager?: HiringManager | null | false; board?: boolean } = {}): string {
  const rows = items.map((it) => {
    const due = dueLabel(it.due_at);
    const dueHtml = due ? `<div style="color:${due.late ? '#B42318;font-weight:600' : '#667085'};font-size:12px;margin-top:2px">${esc(due.text)}</div>` : '';
    return `<tr><td style="padding:8px 10px;border-bottom:1px solid #E7E6E1">${esc(it.label)}${it.detail ? `<div style="color:#667085;font-size:12px">${esc(it.detail)}</div>` : ''}${approver ? approveButton(it, approver.email, approver.base) : ''}</td><td style="padding:8px 10px;border-bottom:1px solid #E7E6E1;color:#667085;font-size:12px;white-space:nowrap;text-align:right">${esc(it.kind)}${dueHtml}</td></tr>`;
  }).join('');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#101828;max-width:560px">
    <p>${intro ? esc(intro) : `New-hire onboarding for <b>${esc(hireName)}</b> has tasks for your team:`}</p>
    ${startLineHtml(start)}${extra.manager === undefined || extra.manager === false ? '' : hiringManagerHtml(extra.manager)}
    <table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${rows}</tbody></table>
    ${extra.board === false ? '' : `<p style="margin-top:16px"><a href="${esc(boardUrl)}" style="background:#101828;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;display:inline-block">Open the onboarding board</a></p>`}
    <p style="color:#667085;font-size:12px">You are receiving this because your team is the routing target for these onboarding tasks.${extra.board === false ? '' : ' Nothing provisions automatically: each item waits for the owner to act.'}</p>
  </div>`;
}

/** Email each owner lane's tasks to its routed address (hr@, IT MSP, accounting). Best-effort and
 *  keyless-safe: a no-op when mail is not connected or no owner has a mapped address. */
export async function notifyOwners(request: any, items: OnboardingItem[], base: string, opts: { intro?: string; subjectPrefix?: string } = {}): Promise<{ sent: number }> {
  if (!mailCredsPresent()) return { sent: 0 };
  const sender = senderFor('onboarding');
  if (!sender) return { sent: 0 };
  const map = ownerEmailMap();
  const byEmail = new Map<string, OnboardingItem[]>();
  for (const it of items) {
    if (it.status !== 'pending') continue; // only notify about work still to do
    const email = recipientFor(it, map);
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email)!.push(it);
  }
  if (!byEmail.size) return { sent: 0 };
  const boardUrl = `${base}/onboarding`;
  let sent = 0;
  const start = startDateInfo(request.start_date);
  for (const [email, its] of byEmail) {
    const html = ownerTasksHtml(request.name, its, boardUrl, start, opts.intro, { email, base },
      { manager: wantsManager(email, map) ? hiringManagerFor(request) : false, board: showsBoard(email, map) });
    // eslint-disable-next-line no-await-in-loop
    const out = await sendMail(email, (opts.subjectPrefix || '') + ownerSubject(request.name, start), html, { from: sender.address, fromName: sender.name });
    if (out.ok) sent++;
  }
  return { sent };
}

/* ─────────────────────────── test approval email ─────────────────────────── */

/** The test approvals: a made-up hire and one approval each. Their links sign item 0 (computer) or
 *  -1 (license), which the approval page treats as a test: it looks and behaves like the real one but
 *  records nothing. */
export type TestApprovalKind = 'computer' | 'license';
export const TEST_ITEM_ID: Record<TestApprovalKind, number> = { computer: 0, license: -1 };
const TEST_APPROVALS: Record<TestApprovalKind, { owner: Owner; owner_label: string; label: string; detail: string; intro: string; next: string }> = {
  computer: {
    owner: 'manager', owner_label: 'Approving manager (one level up)', label: 'Approve new computer',
    detail: 'Standard laptop. Approver: you (this is a test)',
    intro: 'TEST: this is the laptop approval email the approving manager (the hire\'s manager\'s manager) gets. Try the button: approving or declining a test records nothing.',
    next: 'Order and set up new computer for Test Hire',
  },
  license: {
    owner: 'it_manager', owner_label: 'IT manager (approval)', label: 'Approve Bluebeam license',
    detail: 'Licensed software: needs the IT manager\'s sign-off before the seat is bought or assigned (this is a test)',
    intro: 'TEST: this is the email you get when a new hire needs a paid license (Bluebeam, AutoCAD, HydraCAD). Try the button: approving or declining a test records nothing.',
    next: 'Install Bluebeam',
  },
};
export function testApproval(email: string, kind: TestApprovalKind = 'computer', now = new Date()): { item: OnboardingItem; hire: { name: string; start_date: string; job_position: string }; next: string; intro: string } {
  const start = new Date(now.getTime() + 14 * 86400000).toISOString().slice(0, 10);
  const t = TEST_APPROVALS[kind];
  return {
    hire: { name: 'Test Hire', start_date: start, job_position: 'Fire Sprinkler Inspector' },
    next: t.next, intro: t.intro,
    item: {
      id: TEST_ITEM_ID[kind], request_id: 0, owner: t.owner, owner_label: t.owner_label, kind: 'approval',
      label: t.label, detail: t.detail, status: 'pending',
      email_to: email, due_at: start, decided_by: null, decided_at: null, created_at: now.toISOString(),
    },
  };
}

/** Send an approval email exactly as the approver gets it, for a made-up hire, so it can be checked end to end. */
export async function sendTestApprovalEmail(to: string, base: string, kind: TestApprovalKind = 'computer'): Promise<{ ok: boolean; error?: string }> {
  if (!mailCredsPresent()) return { ok: false, error: 'Mail is not connected.' };
  const sender = senderFor('onboarding');
  if (!sender) return { ok: false, error: 'No onboarding sender is set.' };
  const { item, hire, intro } = testApproval(to, kind);
  const start = startDateInfo(hire.start_date);
  const html = ownerTasksHtml(hire.name, [item], `${base}/onboarding`, start, intro, { email: to, base });
  const out = await sendMail(to, '[Test] ' + ownerSubject(hire.name, start), html, { from: sender.address, fromName: sender.name });
  return out.ok ? { ok: true } : { ok: false, error: (out as any).error || 'send failed' };
}

/* ─────────────────────────── manual per-lane email (generate + send) ─────────────────────────── */
import { getDb } from '../db/index';

export interface OwnerEmailPreview { to: string | null; subject: string; html: string; text: string; count: number; ownerLabel: string }

/** Build the email for one owner lane of a request: recipient, subject, HTML and a plain-text body
 *  (for copy/paste), so it can be previewed and sent, or sent by hand from your own mailbox. */
export function ownerEmailPreview(requestId: number, owner: Owner, base: string): OwnerEmailPreview | null {
  const db = getDb();
  const request = db.prepare(`SELECT id, name, start_date, employee_id, manager_name FROM onboarding_requests WHERE id = ?`).get(requestId) as { id: number; name: string; start_date: string | null; employee_id: number | null; manager_name: string | null } | undefined;
  if (!request) return null;
  const allItems = db.prepare(`SELECT * FROM onboarding_items WHERE request_id = ? AND owner = ? ORDER BY id`).all(requestId, owner) as OnboardingItem[];
  const ownerLabel = (allItems[0] && allItems[0].owner_label) || owner;
  // Only email what's still to do: drop items already done or discarded, so the email reflects the
  // live board and shrinks as tasks are completed.
  const items = allItems.filter((it) => it.status === 'pending');
  const to = (items[0] && recipientFor(items[0])) || ownerEmailMap()[owner] || null;
  const start = startDateInfo(request.start_date);
  const subject = ownerSubject(request.name, start, ownerLabel);
  const boardUrl = `${base}/onboarding`;
  const hm = wantsManager(to) ? hiringManagerFor(request) : false;
  const board = showsBoard(to);
  const html = items.length ? ownerTasksHtml(request.name, items, boardUrl, start, undefined, to ? { email: to, base } : undefined, { manager: hm, board }) : '';
  const text = [
    `Onboarding for ${request.name}: ${ownerLabel}`,
    start ? `Start date: ${start.long}${start.relative ? ` (${start.relative})` : ''}` : 'Start date: not provided yet',
    ...(hm !== false ? [`Hiring manager: ${hm ? [hm.name, hm.email].filter(Boolean).join(', ') : 'not on file yet'}`] : []),
    '',
    ...items.map((it) => `- ${it.label}${it.detail ? ` (${it.detail})` : ''}`),
    ...(board ? ['', `Open the board: ${boardUrl}`] : []),
  ].join('\n');
  return { to, subject, html, text, count: items.length, ownerLabel };
}

/** Send one owner lane's email now, via the OS mailbox. Keyless-safe. */
export async function sendOwnerEmailNow(requestId: number, owner: Owner, base: string): Promise<{ ok: boolean; to?: string; error?: string }> {
  const p = ownerEmailPreview(requestId, owner, base);
  if (!p) return { ok: false, error: 'request not found' };
  if (!p.count) return { ok: false, error: 'no tasks in this lane' };
  if (!p.to) return { ok: false, error: `No routing address set for ${p.ownerLabel}. Set one in the owner-email settings.` };
  if (!mailCredsPresent()) return { ok: false, error: 'Microsoft 365 mail is not connected.' };
  const sender = senderFor('onboarding');
  if (!sender) return { ok: false, error: 'No sending mailbox set for onboarding.' };
  const out = await sendMail(p.to, p.subject, p.html, { from: sender.address, fromName: sender.name });
  return out.ok ? { ok: true, to: p.to } : { ok: false, error: out.error };
}

/* ─────────────────────────── follow-ups, start-date changes, rejections, reminders ─────────────────────────── */
import { managerEmailFor, resolveHireManager } from './onboardingAgent';
import { approvalUrl } from './approvalLinks';
import { inSendWindow } from './reviewRequests';
import { getState as getS, setState as setS } from '../db/schema';

function requestRow(requestId: number): any {
  return getDb().prepare(`SELECT * FROM onboarding_requests WHERE id = ?`).get(requestId);
}
function pendingItems(requestId: number): OnboardingItem[] {
  return getDb().prepare(`SELECT * FROM onboarding_items WHERE request_id = ? AND status = 'pending' ORDER BY id`).all(requestId) as OnboardingItem[];
}

/** An approval unlocked work: tell the team that now has to deliver it. */
export async function notifyFollowUp(approval: OnboardingItem, followUp: OnboardingItem, by: string, base: string): Promise<{ sent: number }> {
  const req = requestRow(followUp.request_id);
  if (!req) return { sent: 0 };
  return notifyOwners(req, [followUp], base, {
    intro: `${approval.label.replace(/^Approve /, '')} was approved by ${by} for ${req.name}. Next step for your team:`,
    subjectPrefix: 'Approved, next step: ',
  });
}

/** The start date moved: re-send each lane its still-open tasks with the new dates. */
export async function notifyStartDateChange(requestId: number, from: string | null, base: string): Promise<{ sent: number }> {
  const req = requestRow(requestId);
  if (!req) return { sent: 0 };
  const items = pendingItems(requestId);
  if (!items.length) return { sent: 0 };
  const was = startDateInfo(from);
  return notifyOwners(req, items, base, {
    intro: `The start date for ${req.name} changed${was ? ` from ${was.long}` : ''}. Your open tasks are re-dated:`,
    subjectPrefix: 'Start date changed: ',
  });
}

/** An approval was turned down: tell the hire's manager, with the reason, so it can be sorted out. */
export async function notifyRejection(item: OnboardingItem, by: string, base: string): Promise<{ ok: boolean; to?: string; error?: string }> {
  if (!mailCredsPresent()) return { ok: false, error: 'mail not connected' };
  const sender = senderFor('onboarding');
  if (!sender) return { ok: false, error: 'no onboarding sender' };
  const req = requestRow(item.request_id);
  let to = req ? managerEmailFor(req.id) : null;
  // The manager turned it down themselves: tell IT (who would have ordered it), not the manager.
  if (to && to.toLowerCase() === String(by).toLowerCase()) to = ownerEmailMap().it_manager || ownerEmailMap().it || null;
  if (!req || !to) return { ok: false, error: 'no manager email on file' };
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#101828;max-width:560px">
    <p>For <b>${esc(req.name)}</b>'s onboarding, <b>${esc(item.label.replace(/^Approve /, ''))}</b> was not approved by ${esc(by)}.</p>
    ${item.detail ? `<p style="color:#667085;font-size:13px">${esc(item.detail)}</p>` : ''}
    <p style="padding:10px 12px;background:#FEF3F2;border-radius:8px;font-size:14px"><b>Reason:</b> ${esc(item.note || 'No reason given.')}</p>
    <p>Reply to this email or talk to ${esc(by)} if something else is needed instead.</p>
    <p style="margin-top:16px"><a href="${esc(base)}/onboarding" style="background:#101828;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;display:inline-block">Open the onboarding board</a></p>
  </div>`;
  const out = await sendMail(to, `Not approved: ${item.label.replace(/^Approve /, '')} for ${req.name}`, html, { from: sender.address, fromName: sender.name });
  return out.ok ? { ok: true, to } : { ok: false, error: out.error };
}

/**
 * The daily nudge: one email per lane address listing every open onboarding task that is overdue or
 * due within two days, across all hires. Weekdays in business hours, at most once a day per address.
 */
export async function sendOnboardingReminders(base: string, now = new Date()): Promise<{ sent: number; addresses: number; items: number; waiting?: boolean }> {
  if (!inSendWindow(now)) return { sent: 0, addresses: 0, items: 0, waiting: true };
  if (!mailCredsPresent()) return { sent: 0, addresses: 0, items: 0 };
  const sender = senderFor('onboarding');
  if (!sender) return { sent: 0, addresses: 0, items: 0 };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const soon = new Date(Date.parse(`${today}T12:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
  const rows = getDb().prepare(
    `SELECT i.*, r.name AS hire, r.start_date AS start_date, r.employee_id AS hire_employee_id, r.manager_name AS hire_manager_name FROM onboarding_items i JOIN onboarding_requests r ON r.id = i.request_id
      WHERE i.status = 'pending' AND i.due_at IS NOT NULL AND i.due_at <= ? AND (r.status = 'open' OR r.status IS NULL)
      ORDER BY i.due_at, r.name, i.id`
  ).all(soon) as (OnboardingItem & { hire: string; start_date: string | null; hire_employee_id: number | null; hire_manager_name: string | null })[];
  const map = ownerEmailMap();
  const byEmail = new Map<string, typeof rows>();
  for (const r of rows) {
    const email = recipientFor(r, map);
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email)!.push(r);
  }
  let sent = 0;
  for (const [email, items] of byEmail) {
    const key = `onboarding_reminder_sent:${email.toLowerCase()}`;
    if (getS(key) === today) continue;
    const late = items.filter((i) => (i.due_at as string) < today).length;
    const hires = new Map<string, typeof items>();
    for (const i of items) { const k = `${i.request_id}`; if (!hires.has(k)) hires.set(k, []); hires.get(k)!.push(i); }
    const sections = [...hires.values()].map((its) => {
      const st = startDateInfo(its[0].start_date);
      const hm = wantsManager(email, map) ? hiringManagerFor({ id: its[0].request_id, employee_id: its[0].hire_employee_id, manager_name: its[0].hire_manager_name }) : false;
      const hmLine = hm === false ? '' : `<div style="font-size:13px;color:#667085;margin:0 0 4px">Hiring manager: ${hm ? esc([hm.name, hm.email].filter(Boolean).join(', ')) : 'not on file yet'}</div>`;
      return `<h3 style="font-size:15px;margin:18px 0 4px">${esc(its[0].hire)}${st ? ` <span style="font-weight:400;color:#667085;font-size:13px">starts ${esc(st.long)}${st.relative ? ` (${esc(st.relative)})` : ''}</span>` : ''}</h3>` + hmLine +
        `<table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${its.map((it) => {
          const due = dueLabel(it.due_at, now);
          return `<tr><td style="padding:6px 10px;border-bottom:1px solid #E7E6E1">${esc(it.label)}${approveButton(it, email, base)}</td><td style="padding:6px 10px;border-bottom:1px solid #E7E6E1;white-space:nowrap;text-align:right;font-size:12px;color:${due && due.late ? '#B42318;font-weight:600' : '#667085'}">${esc(due ? due.text : '')}</td></tr>`;
        }).join('')}</tbody></table>`;
    }).join('');
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#101828;max-width:600px">
      <p>${late ? `<b>${late} onboarding task${late === 1 ? ' is' : 's are'} overdue.</b> ` : ''}Here is everything your team has due in the next two days for new hires:</p>${sections}
      ${showsBoard(email, map) ? `<p style="margin-top:18px"><a href="${esc(base)}/onboarding" style="background:#101828;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;display:inline-block">Open the onboarding board</a></p>` : ''}</div>`;
    // eslint-disable-next-line no-await-in-loop
    const out = await sendMail(email, `${late ? `${late} overdue, ` : ''}${items.length} onboarding task${items.length === 1 ? '' : 's'} due`, html, { from: sender.address, fromName: sender.name });
    if (out.ok) { setS(key, today); sent++; }
  }
  return { sent, addresses: byEmail.size, items: rows.length };
}
