/**
 * My tasks: a personal to-do list with due dates and a daily email.
 *
 * Only the people listed in PERSONAL_TASK_USERS can use it (just the IT manager for now). Each item
 * belongs to the signed-in person's email, and every morning (7am Central, every day) that person
 * gets one email with what is overdue, due today, and coming up, each with a one-click "Mark done"
 * link. The link is signed for one item and one person; opening it shows a button, because mail
 * scanners open links and a plain GET must never change anything.
 */
import crypto from 'crypto';
import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { sendMail, mailCredsPresent } from './msGraphMail';
import { senderFor } from './mailSenders';

const TZ = 'America/Chicago';
const SEND_HOUR = 7;
const LINK_TTL_MS = 45 * 86400000;

export interface PersonalTask {
  id: number; owner_email: string; title: string; notes: string | null; due_date: string | null;
  status: 'open' | 'done'; created_at: string; done_at: string | null;
}

export function taskUsers(): string[] {
  const raw = process.env.PERSONAL_TASK_USERS || 'devon.booker@1stfpservices.com';
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}
export function canUseTasks(email: string | null | undefined): boolean {
  return !!email && taskUsers().includes(String(email).toLowerCase());
}

/** Today's date (YYYY-MM-DD) and hour in Central time. */
export function centralNow(now = new Date()): { date: string; hour: number } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now)) % 24;
  return { date, hour };
}
function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
function cleanDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function cleanText(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+$/g, '').slice(0, max);
}

export function listTasks(owner: string): PersonalTask[] {
  return getDb().prepare(
    `SELECT * FROM personal_tasks WHERE owner_email = ?
      ORDER BY status = 'done', CASE WHEN status = 'done' THEN done_at END DESC, due_date IS NULL, due_date, id`
  ).all(owner.toLowerCase()) as PersonalTask[];
}
function getTask(owner: string, id: number): PersonalTask | null {
  return (getDb().prepare(`SELECT * FROM personal_tasks WHERE id = ? AND owner_email = ?`).get(id, owner.toLowerCase()) as PersonalTask) || null;
}

export function addTask(owner: string, input: { title?: unknown; notes?: unknown; due_date?: unknown }): PersonalTask | { error: string } {
  const title = cleanText(input.title, 300).trim();
  if (!title) return { error: 'Give the task a name.' };
  const info = getDb().prepare(`INSERT INTO personal_tasks (owner_email, title, notes, due_date) VALUES (?, ?, ?, ?)`)
    .run(owner.toLowerCase(), title, cleanText(input.notes, 2000).trim() || null, cleanDate(input.due_date));
  return getTask(owner, Number(info.lastInsertRowid))!;
}

export function updateTask(owner: string, id: number, input: { title?: unknown; notes?: unknown; due_date?: unknown; done?: unknown }): PersonalTask | { error: string } | null {
  const t = getTask(owner, id);
  if (!t) return null;
  const title = input.title !== undefined ? cleanText(input.title, 300).trim() : t.title;
  if (!title) return { error: 'Give the task a name.' };
  const notes = input.notes !== undefined ? (cleanText(input.notes, 2000).trim() || null) : t.notes;
  const due = input.due_date !== undefined ? cleanDate(input.due_date) : t.due_date;
  let status = t.status, doneAt = t.done_at;
  if (input.done !== undefined) {
    status = input.done ? 'done' : 'open';
    doneAt = input.done ? (t.done_at || new Date().toISOString()) : null;
  }
  getDb().prepare(`UPDATE personal_tasks SET title = ?, notes = ?, due_date = ?, status = ?, done_at = ? WHERE id = ? AND owner_email = ?`)
    .run(title, notes, due, status, doneAt, id, owner.toLowerCase());
  return getTask(owner, id);
}

export function deleteTask(owner: string, id: number): boolean {
  return getDb().prepare(`DELETE FROM personal_tasks WHERE id = ? AND owner_email = ?`).run(id, owner.toLowerCase()).changes > 0;
}

/* ─────────── one-click "Mark done" links ─────────── */
function secret(): string {
  return crypto.createHash('sha256').update('fpos-personal-task|' + (process.env.PEOPLE_SESSION_SECRET || process.env.APP_PASSWORD || 'dev-task-secret')).digest('hex');
}
export function signDone(taskId: number, email: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ t: taskId, e: email.toLowerCase(), x: now + LINK_TTL_MS })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}
export function verifyDone(token: string, now = Date.now()): { taskId: number; email: string } | null {
  const t = String(token || '');
  const dot = t.indexOf('.');
  if (dot < 1) return null;
  const body = t.slice(0, dot), sig = t.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof d.t !== 'number' || typeof d.e !== 'string' || typeof d.x !== 'number' || d.x < now) return null;
    if (!canUseTasks(d.e)) return null;
    return { taskId: d.t, email: d.e };
  } catch { return null; }
}
export function taskForToken(token: string): { task: PersonalTask; email: string } | null {
  const v = verifyDone(token);
  if (!v) return null;
  const task = getTask(v.email, v.taskId);
  return task ? { task, email: v.email } : null;
}

/* ─────────── the daily email ─────────── */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
function niceDate(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

export interface Digest { subject: string; html: string; count: number }

/** Group open tasks into overdue / today / next 7 days / later / no date and render the email. */
export function buildDigest(owner: string, base: string, now = new Date()): Digest | null {
  const open = listTasks(owner).filter((t) => t.status === 'open');
  if (!open.length) return null;
  const today = centralNow(now).date, week = addDays(today, 7);
  const groups: { label: string; tone: string; items: PersonalTask[] }[] = [
    { label: 'Overdue', tone: '#B42318', items: open.filter((t) => t.due_date && t.due_date < today) },
    { label: 'Due today', tone: '#d62d2a', items: open.filter((t) => t.due_date === today) },
    { label: 'Next 7 days', tone: '#1d1d1f', items: open.filter((t) => t.due_date && t.due_date > today && t.due_date <= week) },
    { label: 'Later', tone: '#6e6e73', items: open.filter((t) => t.due_date && t.due_date > week) },
    { label: 'No due date', tone: '#6e6e73', items: open.filter((t) => !t.due_date) },
  ];
  const overdue = groups[0].items.length, dueToday = groups[1].items.length;
  const b = base.replace(/\/$/, '');
  const row = (t: PersonalTask) => {
    const days = t.due_date ? Math.round((Date.parse(`${t.due_date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000) : null;
    const when = t.due_date ? (days! < 0 ? `${niceDate(t.due_date)} · ${-days!} day${days === -1 ? '' : 's'} late` : days === 0 ? 'Today' : niceDate(t.due_date)) : '';
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #e8e8ed;vertical-align:top">
        <div style="font-size:15px;font-weight:600;color:#1d1d1f">${esc(t.title)}</div>
        ${t.notes ? `<div style="font-size:13px;color:#6e6e73;margin-top:2px;white-space:pre-wrap">${esc(t.notes)}</div>` : ''}
        ${when ? `<div style="font-size:12px;color:${days! < 0 ? '#B42318' : '#6e6e73'};margin-top:3px">${esc(when)}</div>` : ''}
      </td><td style="padding:10px 0 10px 12px;border-bottom:1px solid #e8e8ed;text-align:right;vertical-align:top;white-space:nowrap">
        <a href="${esc(`${b}/tasks/done/${signDone(t.id, owner)}`)}" style="display:inline-block;padding:7px 13px;border-radius:980px;border:1px solid #d2d2d7;color:#1d1d1f;text-decoration:none;font-size:13px;font-weight:600">Mark done</a>
      </td></tr>`;
  };
  const sections = groups.filter((g) => g.items.length).map((g) =>
    `<div style="margin:22px 0 4px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${g.tone}">${esc(g.label)} (${g.items.length})</div>
     <table style="width:100%;border-collapse:collapse">${g.items.map(row).join('')}</table>`).join('');
  const lead = overdue || dueToday
    ? `${dueToday ? `${dueToday} due today` : ''}${dueToday && overdue ? ' and ' : ''}${overdue ? `${overdue} overdue` : ''}.`
    : `Nothing due today. ${open.length} open task${open.length === 1 ? '' : 's'} on your list.`;
  const html = `<div style="font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;color:#1d1d1f;max-width:560px">
    <p style="font-size:20px;font-weight:800;letter-spacing:-.02em;margin:0 0 4px">Your tasks for ${esc(niceDate(today))}</p>
    <p style="font-size:14px;color:#6e6e73;margin:0">${esc(lead)}</p>
    ${sections}
    <p style="margin-top:22px"><a href="${esc(`${b}/?tab=myTasks`)}" style="background:#d62d2a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:980px;display:inline-block;font-weight:700;font-size:14px">Open My tasks</a></p>
    <p style="font-size:12px;color:#86868b;margin-top:18px">Sent every morning while you have open tasks. Add, change or finish them in the OS under IT, My tasks.</p>
  </div>`;
  const subject = overdue || dueToday
    ? `Tasks: ${[dueToday ? `${dueToday} due today` : '', overdue ? `${overdue} overdue` : ''].filter(Boolean).join(', ')}`
    : `Tasks: ${open.length} open, nothing due today`;
  return { subject, html, count: open.length };
}

export async function sendDigestNow(owner: string, base: string, now = new Date()): Promise<{ ok: boolean; error?: string; count?: number }> {
  if (!mailCredsPresent()) return { ok: false, error: 'Microsoft 365 mail is not connected.' };
  const sender = senderFor('onboarding');
  if (!sender) return { ok: false, error: 'No sending mailbox is set.' };
  const d = buildDigest(owner, base, now);
  if (!d) return { ok: false, error: 'You have no open tasks, so there is nothing to send.' };
  const out = await sendMail(owner, d.subject, d.html, { from: sender.address, fromName: sender.name });
  return out.ok ? { ok: true, count: d.count } : { ok: false, error: (out as any).error || 'send failed' };
}

/** Run by the scheduler: once a day after 7am Central, email each user who has open tasks. */
export async function sendDailyTaskDigests(base: string, now = new Date()): Promise<{ sent: number; waiting?: boolean }> {
  const { date, hour } = centralNow(now);
  if (hour < SEND_HOUR) return { sent: 0, waiting: true };
  let sent = 0;
  for (const owner of taskUsers()) {
    const key = `personal_tasks_digest:${owner}`;
    if (getState(key) === date) continue;
    if (!buildDigest(owner, base, now)) { setState(key, date); continue; }
    const out = await sendDigestNow(owner, base, now);
    if (out.ok) { setState(key, date); sent++; }
  }
  return { sent };
}
