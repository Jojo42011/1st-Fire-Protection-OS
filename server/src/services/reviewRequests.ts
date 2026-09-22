import crypto from 'crypto';
import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { mailConfigured, sendMail } from './msGraphMail';
import { senderFor } from './mailSenders';
import { renderEmail, p, em, escapeHtml } from './emailShell';

/**
 * Google review requests, routed per office.
 *
 * A completed ServiceTrade job carries assignedOffice (which Northstar branch serviced it) and
 * primaryContact (who to ask). We map each office to its public Google "write a review" link,
 * then on completion send that customer a request pointing at THEIR office's link, so the
 * review lands on the right profile.
 *
 * Send mode is 'hold' (queue for review) or 'auto' (send on completion). Guardrails: only jobs
 * with a mapped+active office and a contact email; one request per email per 90 days.
 */

const DEDUPE_DAYS = 90;
// Automatic requests only cover recent work. Older history (pulled for campaign sizing, or an old
// job ServiceTrade happens to touch) must never trigger a review request on its own.
export const SWEEP_MAX_AGE_DAYS = 180;

export interface ReviewTarget {
  office_id: string;
  office_name: string | null;
  place_id: string | null;
  review_url: string | null;
  phone: string | null;
  active: number;
}

/** Parse a pasted Google review link OR a bare place id into {review_url, place_id}. */
export function parseReviewLink(input: string): { review_url: string; place_id: string | null } {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('empty link');
  // bare place id (ChIJ… or a hex/underscore id) with no scheme → build the canonical writereview url
  if (!/^https?:\/\//i.test(raw) && !raw.includes('/') && !raw.includes(' ')) {
    return { review_url: `https://search.google.com/local/writereview?placeid=${encodeURIComponent(raw)}`, place_id: raw };
  }
  let place_id: string | null = null;
  const pid = raw.match(/[?&]placeid=([^&]+)/i);
  if (pid) place_id = decodeURIComponent(pid[1]);
  return { review_url: raw, place_id };
}

function targetsMap(): Record<string, ReviewTarget> {
  const rows = getDb().prepare(`SELECT * FROM review_targets`).all() as ReviewTarget[];
  const m: Record<string, ReviewTarget> = {};
  for (const r of rows) m[r.office_id] = r;
  return m;
}

/** Offices discovered from real jobs, joined with their mapping state. */
export function discoverOffices() {
  const rows = getDb()
    .prepare(
      `SELECT office_id, MAX(office_name) AS office_name, COUNT(*) AS jobs,
              SUM(CASE WHEN lower(status) LIKE '%complete%' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN contact_email IS NOT NULL THEN 1 ELSE 0 END) AS with_contact,
              MAX(office_phone) AS st_phone
         FROM crm_jobs
        WHERE source = 'servicetrade' AND office_id IS NOT NULL
        GROUP BY office_id ORDER BY jobs DESC`
    )
    .all() as { office_id: string; office_name: string; jobs: number; completed: number; with_contact: number; st_phone: string | null }[];
  const map = targetsMap();
  const clicks = getDb()
    .prepare(
      `SELECT j.office_id, COUNT(*) AS tracked, SUM(CASE WHEN rr.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
         FROM review_requests rr JOIN crm_jobs j ON j.id = rr.job_id
        WHERE rr.source = 'servicetrade' AND rr.status = 'sent' AND rr.token IS NOT NULL
        GROUP BY j.office_id`
    )
    .all() as { office_id: string; tracked: number; clicked: number }[];
  const clickBy = new Map(clicks.map((c) => [c.office_id, c]));
  return rows.map((r) => {
    const t = map[r.office_id];
    const c = clickBy.get(r.office_id);
    return { ...r, review_url: t ? t.review_url : null, phone: (t && t.phone) || r.st_phone || null, active: t ? t.active : 1, mapped: !!(t && t.review_url),
      tracked: c ? c.tracked : 0, clicked: c ? c.clicked || 0 : 0 };
  });
}

export function getTargets(): ReviewTarget[] {
  return getDb().prepare(`SELECT * FROM review_targets ORDER BY office_name`).all() as ReviewTarget[];
}

/** Map (or re-map) an office to a Google review link, with an optional phone override. */
export function setTarget(officeId: string, officeName: string | null, link: string, phone?: string | null): ReviewTarget {
  const { review_url, place_id } = parseReviewLink(link);
  const ph = phone != null && String(phone).trim() !== '' ? String(phone).trim() : null;
  getDb()
    .prepare(
      `INSERT INTO review_targets (office_id, office_name, place_id, review_url, phone, active, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(office_id) DO UPDATE SET office_name=excluded.office_name, place_id=excluded.place_id,
         review_url=excluded.review_url, phone=excluded.phone, updated_at=datetime('now')`
    )
    .run(officeId, officeName, place_id, review_url, ph);
  return getDb().prepare(`SELECT * FROM review_targets WHERE office_id = ?`).get(officeId) as ReviewTarget;
}

export function setTargetActive(officeId: string, active: boolean): void {
  getDb().prepare(`UPDATE review_targets SET active = ?, updated_at = datetime('now') WHERE office_id = ?`).run(active ? 1 : 0, officeId);
}

export function getMode(): 'hold' | 'auto' {
  return getState('review_send_mode') === 'auto' ? 'auto' : 'hold';
}
export function setMode(mode: 'hold' | 'auto'): void {
  setState('review_send_mode', mode === 'auto' ? 'auto' : 'hold');
}

/** Daily send cap protects the sending domain's reputation when draining a backlog. */
export function dailyCap(): number {
  const n = parseInt(process.env.REVIEW_DAILY_CAP || '', 10);
  return isFinite(n) && n > 0 ? n : 40;
}
/** Requests and reminders sent since midnight Central (every office is in Central time). */
export function dailySent(now = new Date()): number {
  const since = startOfSendDay(now);
  const v = getDb()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM review_requests WHERE status = 'sent' AND sent_at >= ?)
            + (SELECT COUNT(*) FROM review_requests WHERE reminder_sent_at >= ?) AS v`
    )
    .get(since, since) as { v: number };
  return v.v || 0;
}
function remainingToday(): number {
  return Math.max(0, dailyCap() - dailySent());
}

/* ---- send window: automatic sends go out on weekdays during business hours, Central time ---- */
const SEND_TZ = 'America/Chicago';
const SEND_START_HOUR = 8;
const SEND_END_HOUR = 18; // exclusive: last automatic send starts before 6pm

function tzParts(d: Date): { y: number; m: number; d: number; h: number; mi: number; s: number; wd: string } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: SEND_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
  });
  const o: Record<string, string> = {};
  for (const part of f.formatToParts(d)) o[part.type] = part.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: o.weekday };
}

/** Is `now` inside the automatic send window (Mon to Fri, 8am to 6pm Central)? */
export function inSendWindow(now = new Date()): boolean {
  const c = tzParts(now);
  if (c.wd === 'Sat' || c.wd === 'Sun') return false;
  return c.h >= SEND_START_HOUR && c.h < SEND_END_HOUR;
}

/** ISO instant of the most recent midnight in Central time. */
export function startOfSendDay(now = new Date()): string {
  const c = tzParts(now);
  const guess = Date.UTC(c.y, c.m - 1, c.d);
  const g = tzParts(new Date(guess));
  const offset = Date.UTC(g.y, g.m - 1, g.d, g.h, g.mi, g.s) - guess;
  return new Date(guess - offset).toISOString();
}

/* ---- click tracking ---- */
function publicBase(): string {
  return (process.env.PUBLIC_BASE_URL || 'https://first-fp-os.fly.dev').replace(/\/$/, '');
}
function newToken(): string {
  return crypto.randomBytes(12).toString('base64url');
}
export function trackUrl(token: string): string {
  return `${publicBase()}/r/${token}`;
}
const TOKEN_RE = /^[A-Za-z0-9_-]{12,64}$/;
// Corporate mail filters (Safe Links, Proofpoint, Mimecast) open every link on delivery. Those hits
// are not a customer, so they must not count as a click or they would suppress the reminder.
const SCANNER_UA = /bot|crawl|spider|preview|scan|safelinks|proofpoint|mimecast|barracuda|urldefense|symantec|fireeye|headless|python|curl|wget|java\//i;
const SCANNER_GRACE_MS = 2 * 60 * 1000;

/** Resolve a tracking token to its Google review link, counting it as a click when it looks human. */
export function recordClick(token: string, opts: { method?: string; userAgent?: string; now?: Date } = {}): { url: string | null; counted: boolean } {
  if (!TOKEN_RE.test(token || '')) return { url: null, counted: false };
  const db = getDb();
  const row = db.prepare(`SELECT id, review_url, sent_at, reminder_sent_at FROM review_requests WHERE token = ?`).get(token) as
    | { id: number; review_url: string | null; sent_at: string | null; reminder_sent_at: string | null }
    | undefined;
  if (!row || !row.review_url) return { url: null, counted: false };
  const now = opts.now || new Date();
  const lastSend = Math.max(Date.parse(row.sent_at || '') || 0, Date.parse(row.reminder_sent_at || '') || 0);
  const human = (opts.method || 'GET').toUpperCase() === 'GET'
    && !SCANNER_UA.test(opts.userAgent || '')
    && !!opts.userAgent
    && now.getTime() - lastSend >= SCANNER_GRACE_MS;
  if (human) {
    db.prepare(`UPDATE review_requests SET click_count = COALESCE(click_count, 0) + 1, clicked_at = COALESCE(clicked_at, ?) WHERE id = ?`)
      .run(now.toISOString(), row.id);
  }
  return { url: row.review_url, counted: human };
}

/* ---- tech names ---- */
function firstName(full: string): string | null {
  const w = String(full || '').trim().split(/\s+/)[0] || '';
  if (!/^[A-Za-z][A-Za-z'.-]{1,19}$/.test(w)) return null;
  if (/^(tech|crew|team|sub|subcontractor|unassigned|office)$/i.test(w)) return null;
  return w === w.toUpperCase() || w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
}

/** "Marcus" or "Marcus and Jose" from the stored crew; null for none or a crew of 3+ (reads awkwardly). */
export function techPhrase(techNamesJson: string | null | undefined): string | null {
  let names: string[] = [];
  try { names = JSON.parse(techNamesJson || '[]'); } catch { return null; }
  if (!Array.isArray(names)) return null;
  const firsts = Array.from(new Set(names.map((n) => firstName(String(n))).filter((n): n is string => !!n)));
  if (firsts.length === 1) return firsts[0];
  if (firsts.length === 2) return `${firsts[0]} and ${firsts[1]}`;
  return null;
}

interface JobForReview {
  st_id?: string | null;
  tech_names?: string | null;
  id: number;
  number: string | null;
  kind: string | null;
  completed_at: string | null;
  office_id: string | null;
  office_name: string | null;
  office_phone: string | null;
  target_phone: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  account_name: string | null;
  review_url: string | null;
}

/** Completed real jobs eligible for a request: mapped+active office, a contact email, not yet asked. */
export function pendingReviewJobs(limit = 200): JobForReview[] {
  return getDb()
    .prepare(
      `SELECT j.id, j.st_id, j.number, j.kind, j.completed_at, j.office_id, j.office_name, j.office_phone,
              t.phone AS target_phone, jt.tech_names,
              j.contact_name, j.contact_email, j.contact_phone, a.name AS account_name, t.review_url
         FROM crm_jobs j
         JOIN review_targets t ON t.office_id = j.office_id AND t.active = 1 AND t.review_url IS NOT NULL
         LEFT JOIN accounts a ON a.id = j.account_id
         LEFT JOIN job_techs jt ON jt.job_st_id = j.st_id
        WHERE j.source = 'servicetrade' AND COALESCE(j.review_requested, 0) = 0
          AND lower(j.status) LIKE '%complete%'
          AND j.contact_email IS NOT NULL
          AND j.completed_at >= ?
        ORDER BY j.completed_at DESC
        LIMIT ?`
    )
    .all(new Date(Date.now() - SWEEP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString(), limit) as JobForReview[];
}

function recentlyAsked(email: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS v FROM review_requests
        WHERE recipient_email = ? AND created_at >= datetime('now', ?) LIMIT 1`
    )
    .get(email.toLowerCase(), `-${DEDUPE_DAYS} days`) as { v: number } | undefined;
  return !!row;
}

/**
 * Customer-facing brand for the review-request email. Kept local to this file so the outbound
 * email is correctly branded as 1st Fire Protection now, ahead of the full founder-layer swap
 * (config/constants.ts, which still drives the receptionist + agent copy) that comes later.
 */
const REVIEW_BRAND = {
  name: '1st Fire Protection',
  site: '1stfpservices.com',
};

/** Absolute URL to the brand logo for the email banner. Mail is sent server-side (no request in
 *  scope), so the public base must come from config; falls back to the known production host. */
function brandLogoUrl(): string {
  return `${publicBase()}/brand/logo-email.png`;
}

/** Friendly, recognizable office name for the From line + signature ("1st Fire Protection Houston"). */
export function officeDisplay(officeName: string | null): string {
  if (!officeName) return REVIEW_BRAND.name;
  const clean = officeName.replace(/\bLLC\b/gi, '').replace(/\s+/g, ' ').trim();
  return clean || REVIEW_BRAND.name;
}

/** Format a raw ServiceTrade phone into (xxx) xxx-xxxx when it is a clean 10-digit US number. */
function formatPhone(raw: string | null): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  return raw.trim(); // already formatted or unusual, leave as-is
}

// A job completed more than this many days ago gets the "checking in on past work" wording instead
// of "your recent service", so the ask reads right for an older job.
const FOLLOWUP_AFTER_DAYS = 60;

/** Days since a job completed, or null when the completion date is missing/unparseable. */
function jobAgeDays(completedAt: string | null): number | null {
  if (!completedAt) return null;
  const t = Date.parse(completedAt);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

/** Which wording a job should use: 'recent' for fresh jobs, 'followup' for older ones. */
export function messageVariant(job: { completed_at: string | null }): 'recent' | 'followup' {
  const age = jobAgeDays(job.completed_at);
  return age != null && age > FOLLOWUP_AFTER_DAYS ? 'followup' : 'recent';
}

/** The "recent service" ask (default, for fresh jobs). */
function buildRecentMessage(job: JobForReview, link: string): { subject: string; body: string; html: string; fromName: string } {
  const first = (job.contact_name || '').split(/\s+/)[0] || 'there';
  const office = officeDisplay(job.office_name);
  const city = office.replace(new RegExp(REVIEW_BRAND.name, 'i'), '').replace(/1st\s*FP/i, '').trim(); // "Houston", ...
  const phone = formatPhone(job.target_phone || job.office_phone); // real office number only; no fake fallback
  const tech = techPhrase(job.tech_names);
  const subject = tech ? `How did ${tech} do on your recent service?` : `How was your recent service with ${office}?`;
  const careLine = tech
    ? `We hope ${tech} and our ${office} team took great care of you.`
    : `We hope our ${office} team took great care of you.`;
  const sign = `${office}${phone ? `\n${phone}` : ''} · ${REVIEW_BRAND.site}`;
  const body =
    `Hi ${first},\n\n` +
    `Thank you for choosing ${REVIEW_BRAND.name} for your recent service. ${careLine}\n\n` +
    `If you have a minute, a quick Google review${tech ? ` mentioning ${tech}` : ''} would mean a lot to us and helps other businesses find dependable fire protection. It opens Google and takes about a minute:\n${link}\n\n` +
    `If anything fell short, just reply to this email and we will make it right.\n\n` +
    `Thank you,\n${sign}`;

  const html = renderEmail({
    eyebrow: city || null,
    body:
      p(`Hi ${escapeHtml(first)},`) +
      p(`Thank you for choosing ${em(REVIEW_BRAND.name)} for your recent service. ${escapeHtml(careLine)}`) +
      p(`If you have a minute, a quick Google review${tech ? ` mentioning ${escapeHtml(tech)}` : ''} would mean a lot to us and helps other businesses find dependable fire protection.`, true),
    cta: { label: 'Leave a Google review', url: link },
    note: 'The button opens Google and takes about a minute. If anything fell short, just reply to this email and we will make it right.',
    footerName: office,
    footerMeta: [phone, REVIEW_BRAND.site].filter(Boolean).join(' · '),
    credentials: 'SCTRCA · MBE · SBE · HUB',
    reason: "You're receiving this because we recently completed service at your property.",
    logoUrl: brandLogoUrl(),
  });
  return { subject, body, html, fromName: office };
}

/** The "checking in on past work" ask, for older jobs: leads with concerns, then the review. */
function buildFollowupMessage(job: JobForReview, link: string): { subject: string; body: string; html: string; fromName: string } {
  const first = (job.contact_name || '').split(/\s+/)[0] || 'there';
  const office = officeDisplay(job.office_name);
  const city = office.replace(new RegExp(REVIEW_BRAND.name, 'i'), '').replace(/1st\s*FP/i, '').trim();
  const phone = formatPhone(job.target_phone || job.office_phone);
  const subject = `Following up on your service with ${office}`;
  const sign = `${office}${phone ? `\n${phone}` : ''} · ${REVIEW_BRAND.site}`;
  const body =
    `Hi ${first},\n\n` +
    `We're checking in with customers we've worked with to make sure everything from your ${office} service is still in good shape and you don't have any outstanding concerns. If anything needs another look, just reply to this email and we will take care of it.\n\n` +
    `If everything has been working well, a quick Google review would mean a lot to us and helps other Texas businesses find a team they can trust. It opens Google and takes about a minute:\n${link}\n\n` +
    `Thank you for trusting ${REVIEW_BRAND.name},\n${sign}`;

  const html = renderEmail({
    eyebrow: city || null,
    body:
      p(`Hi ${escapeHtml(first)},`) +
      p(`We're checking in with customers we've worked with to make sure everything from your ${escapeHtml(office)} service is still in good shape and you don't have any outstanding concerns. If anything needs another look, just reply to this email and we will take care of it.`) +
      p(`If everything has been working well, a quick Google review would mean a lot to us and helps other Texas businesses find a team they can trust.`, true),
    cta: { label: 'Leave a Google review', url: link },
    note: 'The button opens Google and takes about a minute. Have a concern instead? Just reply to this email and we will make it right.',
    footerName: office,
    footerMeta: [phone, REVIEW_BRAND.site].filter(Boolean).join(' · '),
    credentials: 'SCTRCA · MBE · SBE · HUB',
    reason: "You're receiving this because we've completed service at your property.",
    logoUrl: brandLogoUrl(),
  });
  return { subject, body, html, fromName: office };
}

/** Pick the wording by job age: fresh jobs get "recent service", older jobs get the follow-up. */
function buildMessage(job: JobForReview, link?: string): { subject: string; body: string; html: string; fromName: string } {
  const url = link || job.review_url || '#';
  return messageVariant(job) === 'followup' ? buildFollowupMessage(job, url) : buildRecentMessage(job, url);
}

/**
 * Queue a review request for one completed job. In 'auto' mode with mail configured it sends
 * immediately; otherwise it is held for review. Idempotent per job (marks review_requested).
 */
/** Insert a request for an already-fetched eligible job (no re-scan). Used by the sweep. */
function queueForJob(job: JobForReview, forceSend = false): { ok: boolean; status: string } {
  const db = getDb();
  if (!job.contact_email) return { ok: false, status: 'skipped' };
  if (recentlyAsked(job.contact_email)) {
    db.prepare(`UPDATE crm_jobs SET review_requested = 1 WHERE id = ?`).run(job.id);
    return { ok: false, status: 'skipped' };
  }
  const token = newToken();
  const { subject, body, html } = buildMessage(job, trackUrl(token));
  // Queue only. Sending is decoupled (drained by sendPending under the daily cap): auto mode
  // marks 'approved' (ready to send), hold mode marks 'held' (awaits your review).
  const status = forceSend || getMode() === 'auto' ? 'approved' : 'held';
  db.prepare(
    `INSERT INTO review_requests (job_id, customer, job_desc, channel, body, html, status, office_name, review_url,
       recipient_email, recipient_phone, subject, source, token, tech_names)
     VALUES (?, ?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, 'servicetrade', ?, ?)`
  ).run(
    job.id, job.account_name || job.contact_name || 'Customer', job.kind || null, body, html, status,
    job.office_name || null, job.review_url || null, job.contact_email, job.contact_phone || null, subject,
    token, job.tech_names || null
  );
  db.prepare(`UPDATE crm_jobs SET review_requested = 1 WHERE id = ?`).run(job.id);
  return { ok: true, status };
}

export async function queueReviewRequest(jobId: number, opts: { forceSend?: boolean } = {}): Promise<{ ok: boolean; status: string; error?: string }> {
  const job = pendingReviewJobs(100000).find((j) => j.id === jobId);
  if (!job) return { ok: false, status: 'skipped', error: 'job not eligible (no mapped office, no contact, or already requested)' };
  return queueForJob(job, opts.forceSend);
}

/**
 * Send queued requests (oldest first), bounded by the remaining daily cap. `onlyApproved`
 * limits it to auto-mode 'approved' items (scheduled drain); otherwise it also sends 'held'
 * items (the human clicked "Send all held"). Returns how many actually went out.
 */
export async function sendPending(onlyApproved = false, now = new Date()): Promise<{ sent: number; capped: boolean; remaining: number; waiting?: boolean }> {
  const db = getDb();
  if (!mailConfigured()) return { sent: 0, capped: false, remaining: remainingToday() };
  // The automatic drain waits for business hours; a person clicking "Send" is not held back.
  if (onlyApproved && !inSendWindow(now)) return { sent: 0, capped: false, remaining: remainingToday(), waiting: true };
  const statuses = onlyApproved ? `('approved')` : `('held','approved')`;
  const room = remainingToday();
  if (room <= 0) return { sent: 0, capped: true, remaining: 0 };
  const rows = db
    .prepare(`SELECT * FROM review_requests WHERE source='servicetrade' AND status IN ${statuses} AND recipient_email IS NOT NULL ORDER BY created_at ASC LIMIT ?`)
    .all(room) as any[];
  let sent = 0;
  for (const r of rows) {
    const office = officeDisplay(r.office_name);
    const html = r.html || (r.body || '').replace(/\n/g, '<br>');
    const res = await sendMail(r.recipient_email, r.subject || `How was your recent service with ${office}?`, html, { from: (senderFor('reviews')||{}).address, fromName: office });
    if (res.ok) { db.prepare(`UPDATE review_requests SET status='sent', sent_at=?, error=NULL WHERE id=?`).run(new Date().toISOString(), r.id); sent++; }
    else { db.prepare(`UPDATE review_requests SET error=? WHERE id=?`).run(res.error || 'send failed', r.id); }
  }
  return { sent, capped: rows.length >= room, remaining: remainingToday() };
}

/* ---- one reminder for requests nobody clicked ---- */
const REMINDER_AFTER_DAYS = 4;
const REMINDER_MAX_AGE_DAYS = 14; // never nudge about a request older than this

function buildReminderMessage(r: { contact_name: string | null; office_name: string | null; target_phone: string | null; office_phone: string | null; tech_names: string | null }, link: string): { subject: string; body: string; html: string } {
  const first = (r.contact_name || '').split(/\s+/)[0] || 'there';
  const office = officeDisplay(r.office_name);
  const city = office.replace(new RegExp(REVIEW_BRAND.name, 'i'), '').replace(/1st\s*FP/i, '').trim();
  const phone = formatPhone(r.target_phone || r.office_phone);
  const tech = techPhrase(r.tech_names);
  const subject = `One quick favor from ${office}`;
  const didRight = tech ? `If ${tech} and our team did right by you` : `If our team did right by you`;
  const body =
    `Hi ${first},\n\n` +
    `Just a short follow-up on our note last week. ${didRight}, a Google review takes about a minute and really helps our ${city || office} team:\n${link}\n\n` +
    `If anything fell short, reply to this email and we will make it right. This is the only reminder we will send.\n\n` +
    `Thank you,\n${office}${phone ? `\n${phone}` : ''} · ${REVIEW_BRAND.site}`;
  const html = renderEmail({
    eyebrow: city || null,
    body:
      p(`Hi ${escapeHtml(first)},`) +
      p(`Just a short follow-up on our note last week. ${escapeHtml(didRight)}, a Google review takes about a minute and really helps our ${escapeHtml(city || office)} team.`, true),
    cta: { label: 'Leave a Google review', url: link },
    note: 'If anything fell short, reply to this email and we will make it right. This is the only reminder we will send.',
    footerName: office,
    footerMeta: [phone, REVIEW_BRAND.site].filter(Boolean).join(' · '),
    credentials: 'SCTRCA · MBE · SBE · HUB',
    reason: "You're receiving this because we recently completed service at your property.",
    logoUrl: brandLogoUrl(),
  });
  return { subject, body, html };
}

/** Requests due a reminder: sent 4 to 14 days ago, never clicked, never reminded, office still active. */
export function remindersDue(now = new Date(), limit = 1000): any[] {
  const day = 24 * 60 * 60 * 1000;
  return getDb()
    .prepare(
      `SELECT rr.id, rr.token, rr.recipient_email, rr.office_name, rr.tech_names,
              j.contact_name, j.office_phone, t.phone AS target_phone
         FROM review_requests rr
         LEFT JOIN crm_jobs j ON j.id = rr.job_id
         LEFT JOIN review_targets t ON t.office_id = j.office_id
        WHERE rr.source = 'servicetrade' AND rr.status = 'sent' AND rr.token IS NOT NULL
          AND rr.recipient_email IS NOT NULL AND rr.clicked_at IS NULL AND rr.reminder_sent_at IS NULL
          AND rr.sent_at <= ? AND rr.sent_at >= ?
          AND COALESCE(t.active, 1) = 1
        ORDER BY rr.sent_at ASC
        LIMIT ?`
    )
    .all(
      new Date(now.getTime() - REMINDER_AFTER_DAYS * day).toISOString(),
      new Date(now.getTime() - REMINDER_MAX_AGE_DAYS * day).toISOString(),
      limit
    ) as any[];
}

/** Send due reminders within business hours, using whatever room is left under today's cap. */
export async function sendReminders(now = new Date()): Promise<{ sent: number; waiting?: boolean }> {
  if (!mailConfigured()) return { sent: 0 };
  if (!inSendWindow(now)) return { sent: 0, waiting: true };
  const room = remainingToday();
  if (room <= 0) return { sent: 0 };
  const db = getDb();
  let sent = 0;
  for (const r of remindersDue(now, room)) {
    const office = officeDisplay(r.office_name);
    const m = buildReminderMessage(r, trackUrl(r.token));
    const res = await sendMail(r.recipient_email, m.subject, m.html, { from: (senderFor('reviews') || {}).address, fromName: office });
    if (res.ok) { db.prepare(`UPDATE review_requests SET reminder_sent_at = ? WHERE id = ?`).run(new Date().toISOString(), r.id); sent++; }
    else { db.prepare(`UPDATE review_requests SET error = ? WHERE id = ?`).run(`reminder: ${res.error || 'send failed'}`, r.id); }
  }
  return { sent };
}

/** Render a sample of the exact customer email (for a test send / preview). When the named office is
 *  mapped, the preview uses that office's REAL Google link and phone, so the button in the preview
 *  goes where a real send would (no misleading placeholder). */
export function renderSample(officeName?: string, variant: 'recent' | 'followup' = 'recent'): { subject: string; body: string; html: string; fromName: string } {
  const name = officeName || '1st Fire Protection Houston';
  let review_url = 'https://g.page/r/Cd6k5KxBJuA9EBM/review';
  let target_phone: string | null = null;
  try {
    const t = getDb().prepare(`SELECT review_url, phone FROM review_targets WHERE lower(office_name) = lower(?) AND review_url IS NOT NULL`).get(name) as { review_url: string; phone: string | null } | undefined;
    if (t) { review_url = t.review_url; target_phone = t.phone; }
  } catch { /* fall back to placeholder */ }
  // Date the sample so it lands in the chosen variant (older than the follow-up threshold, or fresh).
  const completed_at = new Date(Date.now() - (variant === 'followup' ? (FOLLOWUP_AFTER_DAYS + 30) : 3) * 24 * 60 * 60 * 1000).toISOString();
  return buildMessage({
    id: 0, number: null, kind: null, completed_at,
    office_id: null, office_name: name, office_phone: '2813334444', target_phone,
    contact_name: 'Sample Customer', contact_email: null, contact_phone: null, tech_names: '["Marcus Sample"]',
    account_name: null, review_url,
  });
}

/** Sweep newly completed jobs into requests. Returns per-status counts. Bounded per run. */
export async function runReviewSweep(max = 5000): Promise<{ queued: number; skipped: number }> {
  const jobs = pendingReviewJobs(max);
  let skipped = 0, queued = 0;
  for (const j of jobs) {
    const r = queueForJob(j); // uses the already-fetched job (no per-job re-scan)
    if (r.ok) queued++; else skipped++;
  }
  return { queued, skipped };
}

/** Send a specific held/approved request now (the manual "approve & send"). */
export async function sendReviewRequest(id: number): Promise<{ ok: boolean; status: string; error?: string }> {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM review_requests WHERE id = ?`).get(id) as any;
  if (!r) return { ok: false, status: 'error', error: 'request not found' };
  if (r.status === 'sent') return { ok: true, status: 'sent' };
  if (!r.recipient_email) return { ok: false, status: 'error', error: 'no recipient email' };
  const office = officeDisplay(r.office_name);
  const subject = r.subject || `How was your recent service with ${office}?`;
  const html = r.html || (r.body || '').replace(/\n/g, '<br>');
  const res = await sendMail(r.recipient_email, subject, html, { from: (senderFor('reviews')||{}).address, fromName: office });
  if (res.ok) {
    db.prepare(`UPDATE review_requests SET status='sent', sent_at=?, error=NULL WHERE id=?`).run(new Date().toISOString(), id);
    return { ok: true, status: 'sent' };
  }
  db.prepare(`UPDATE review_requests SET status='approved', error=? WHERE id=?`).run(res.error || 'send failed', id);
  return { ok: false, status: 'approved', error: res.error };
}

/**
 * The queue the Reviews screen renders. Held/approved items are the actionable work, so ALL of them
 * are returned (a single LIMIT 200 over held+approved+sent used to truncate the list well below the
 * real held count, and sent rows could even crowd out held ones). Sent items are only a recent log,
 * so those stay capped.
 */
export function reviewRequestQueue(): any[] {
  const db = getDb();
  const cols = `id, customer, office_name, review_url, recipient_email, channel, status, subject, body, sent_at, error, created_at, clicked_at, reminder_sent_at`;
  const pending = db
    .prepare(`SELECT ${cols} FROM review_requests WHERE source = 'servicetrade' AND status IN ('held','approved') ORDER BY created_at DESC`)
    .all();
  const sent = db
    .prepare(`SELECT ${cols} FROM review_requests WHERE source = 'servicetrade' AND status = 'sent' ORDER BY sent_at DESC LIMIT 50`)
    .all();
  return [...pending, ...sent];
}

/**
 * Re-render queued (held/approved) requests so each uses the wording that fits its job's age. An
 * older job flips from "your recent service" to the follow-up ask. Reconstructs the job from crm_jobs
 * by job_id (same joins as pendingReviewJobs) and rewrites subject/body/html in place. Idempotent:
 * re-running produces the same text. Returns how many rows changed, split by variant.
 */
export function rerenderQueued(): { updated: number; followup: number; recent: number; scanned: number } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT rr.id AS rr_id, rr.subject AS old_subject, rr.body AS old_body, rr.token AS rr_token,
              jt.tech_names, j.id, j.st_id, j.number, j.kind, j.completed_at, j.office_id, j.office_name, j.office_phone,
              t.phone AS target_phone, j.contact_name, j.contact_email, j.contact_phone,
              a.name AS account_name, COALESCE(t.review_url, rr.review_url) AS review_url
         FROM review_requests rr
         JOIN crm_jobs j ON j.id = rr.job_id
         LEFT JOIN review_targets t ON t.office_id = j.office_id
         LEFT JOIN accounts a ON a.id = j.account_id
         LEFT JOIN job_techs jt ON jt.job_st_id = j.st_id
        WHERE rr.source = 'servicetrade' AND rr.status IN ('held','approved')`
    )
    .all() as (JobForReview & { rr_id: number; rr_token: string | null; old_subject: string | null; old_body: string | null })[];
  const upd = db.prepare(`UPDATE review_requests SET subject = ?, body = ?, html = ?, token = ?, tech_names = ? WHERE id = ?`);
  let updated = 0, followup = 0, recent = 0;
  for (const r of rows) {
    const variant = messageVariant(r);
    if (variant === 'followup') followup++; else recent++;
    const token = r.rr_token || newToken();
    const m = buildMessage(r, trackUrl(token));
    if (m.subject !== r.old_subject || m.body !== r.old_body || !r.rr_token) { upd.run(m.subject, m.body, m.html, token, r.tech_names || null, r.rr_id); updated++; }
  }
  return { updated, followup, recent, scanned: rows.length };
}

/** Summary for the screen header. */
export function reviewRequestSummary() {
  const db = getDb();
  const n = (sql: string) => (db.prepare(sql).get() as { v: number }).v || 0;
  return {
    mode: getMode(),
    mailReady: mailConfigured(),
    officesTotal: n(`SELECT COUNT(DISTINCT office_id) AS v FROM crm_jobs WHERE source='servicetrade' AND office_id IS NOT NULL`),
    officesMapped: n(`SELECT COUNT(*) AS v FROM review_targets WHERE review_url IS NOT NULL AND active=1`),
    eligible: pendingReviewJobs(100000).length,
    held: n(`SELECT COUNT(*) AS v FROM review_requests WHERE source='servicetrade' AND status IN ('held','approved')`),
    sent: n(`SELECT COUNT(*) AS v FROM review_requests WHERE source='servicetrade' AND status='sent'`),
    dailyCap: dailyCap(),
    dailySent: dailySent(),
    tracked: n(`SELECT COUNT(*) AS v FROM review_requests WHERE source='servicetrade' AND status='sent' AND token IS NOT NULL`),
    clicked: n(`SELECT COUNT(*) AS v FROM review_requests WHERE source='servicetrade' AND status='sent' AND clicked_at IS NOT NULL`),
    reminded: n(`SELECT COUNT(*) AS v FROM review_requests WHERE source='servicetrade' AND reminder_sent_at IS NOT NULL`),
    clickedAfterReminder: n(`SELECT COUNT(*) AS v FROM review_requests WHERE source='servicetrade' AND reminder_sent_at IS NOT NULL AND clicked_at > reminder_sent_at`),
    remindersDue: remindersDue(new Date(), 100000).length,
    inSendWindow: inSendWindow(),
  };
}
