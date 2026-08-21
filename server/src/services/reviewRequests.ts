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
  return rows.map((r) => {
    const t = map[r.office_id];
    return { ...r, review_url: t ? t.review_url : null, phone: (t && t.phone) || r.st_phone || null, active: t ? t.active : 1, mapped: !!(t && t.review_url) };
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
export function dailySent(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS v FROM review_requests WHERE status = 'sent' AND date(sent_at) = date('now')`).get() as { v: number }).v || 0;
}
function remainingToday(): number {
  return Math.max(0, dailyCap() - dailySent());
}

interface JobForReview {
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
      `SELECT j.id, j.number, j.kind, j.completed_at, j.office_id, j.office_name, j.office_phone,
              t.phone AS target_phone,
              j.contact_name, j.contact_email, j.contact_phone, a.name AS account_name, t.review_url
         FROM crm_jobs j
         JOIN review_targets t ON t.office_id = j.office_id AND t.active = 1 AND t.review_url IS NOT NULL
         LEFT JOIN accounts a ON a.id = j.account_id
        WHERE j.source = 'servicetrade' AND COALESCE(j.review_requested, 0) = 0
          AND lower(j.status) LIKE '%complete%'
          AND j.contact_email IS NOT NULL
        ORDER BY j.completed_at DESC
        LIMIT ?`
    )
    .all(limit) as JobForReview[];
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

function buildMessage(job: JobForReview): { subject: string; body: string; html: string; fromName: string } {
  const first = (job.contact_name || '').split(/\s+/)[0] || 'there';
  const office = officeDisplay(job.office_name);
  const city = office.replace(new RegExp(REVIEW_BRAND.name, 'i'), '').replace(/1st\s*FP/i, '').trim(); // "Houston", ...
  const phone = formatPhone(job.target_phone || job.office_phone); // real office number only; no fake fallback
  const subject = `How was your recent service with ${office}?`;
  const sign = `${office}${phone ? `\n${phone}` : ''} · ${REVIEW_BRAND.site}`;
  const body =
    `Hi ${first},\n\n` +
    `Thank you for choosing ${REVIEW_BRAND.name} for your recent service. We hope our ${office} team took great care of you.\n\n` +
    `If you have a minute, a quick Google review would mean a lot to us and helps other businesses find dependable fire protection. It opens Google and takes about a minute:\n${job.review_url || ''}\n\n` +
    `If anything fell short, just reply to this email and we will make it right.\n\n` +
    `Thank you,\n${sign}`;

  const html = renderEmail({
    eyebrow: city || null,
    body:
      p(`Hi ${escapeHtml(first)},`) +
      p(`Thank you for choosing ${em(REVIEW_BRAND.name)} for your recent service. We hope our ${escapeHtml(office)} team took great care of you.`) +
      p(`If you have a minute, a quick Google review would mean a lot to us and helps other businesses find dependable fire protection.`, true),
    cta: { label: 'Leave a Google review', url: job.review_url || '#' },
    note: 'The button opens Google and takes about a minute. If anything fell short, just reply to this email and we will make it right.',
    footerName: office,
    footerMeta: [phone, REVIEW_BRAND.site].filter(Boolean).join(' · '),
    credentials: 'SCTRCA · MBE · SBE · HUB',
    reason: "You're receiving this because we recently completed service at your property.",
  });
  return { subject, body, html, fromName: office };
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
  const { subject, body, html } = buildMessage(job);
  // Queue only. Sending is decoupled (drained by sendPending under the daily cap): auto mode
  // marks 'approved' (ready to send), hold mode marks 'held' (awaits your review).
  const status = forceSend || getMode() === 'auto' ? 'approved' : 'held';
  db.prepare(
    `INSERT INTO review_requests (job_id, customer, job_desc, channel, body, html, status, office_name, review_url,
       recipient_email, recipient_phone, subject, source)
     VALUES (?, ?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, 'servicetrade')`
  ).run(
    job.id, job.account_name || job.contact_name || 'Customer', job.kind || null, body, html, status,
    job.office_name || null, job.review_url || null, job.contact_email, job.contact_phone || null, subject
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
export async function sendPending(onlyApproved = false): Promise<{ sent: number; capped: boolean; remaining: number }> {
  const db = getDb();
  if (!mailConfigured()) return { sent: 0, capped: false, remaining: remainingToday() };
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

/** Render a sample of the exact customer email (for a test send / preview). */
export function renderSample(officeName?: string): { subject: string; body: string; html: string; fromName: string } {
  return buildMessage({
    id: 0, number: null, kind: null, completed_at: null,
    office_id: null, office_name: officeName || '1st Fire Protection Houston', office_phone: '2813334444', target_phone: null,
    contact_name: 'Sample Customer', contact_email: null, contact_phone: null,
    account_name: null, review_url: 'https://g.page/r/Cd6k5KxBJuA9EBM/review',
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

export function reviewRequestQueue(): any[] {
  return getDb()
    .prepare(
      `SELECT id, customer, office_name, review_url, recipient_email, channel, status, subject, body, sent_at, error, created_at
         FROM review_requests WHERE source = 'servicetrade' ORDER BY created_at DESC LIMIT 200`
    )
    .all();
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
  };
}
