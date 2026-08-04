import { getDb } from '../db/index';
import { COMPANY } from '../config/constants';
import { getState, setState } from '../db/schema';
import { mailConfigured, sendMail } from './msGraphMail';

/**
 * Google review requests, routed per office.
 *
 * A completed ServiceTrade job carries assignedOffice (which 1st FP branch serviced it) and
 * primaryContact (who to ask). We map each office to its public Google "write a review" link,
 * then on completion send that customer a request pointing at THEIR office's link — so the
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
              SUM(CASE WHEN contact_email IS NOT NULL THEN 1 ELSE 0 END) AS with_contact
         FROM crm_jobs
        WHERE source = 'servicetrade' AND office_id IS NOT NULL
        GROUP BY office_id ORDER BY jobs DESC`
    )
    .all() as { office_id: string; office_name: string; jobs: number; completed: number; with_contact: number }[];
  const map = targetsMap();
  return rows.map((r) => {
    const t = map[r.office_id];
    return { ...r, review_url: t ? t.review_url : null, active: t ? t.active : 1, mapped: !!(t && t.review_url) };
  });
}

export function getTargets(): ReviewTarget[] {
  return getDb().prepare(`SELECT * FROM review_targets ORDER BY office_name`).all() as ReviewTarget[];
}

/** Map (or re-map) an office to a Google review link. */
export function setTarget(officeId: string, officeName: string | null, link: string): ReviewTarget {
  const { review_url, place_id } = parseReviewLink(link);
  getDb()
    .prepare(
      `INSERT INTO review_targets (office_id, office_name, place_id, review_url, active, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(office_id) DO UPDATE SET office_name=excluded.office_name, place_id=excluded.place_id,
         review_url=excluded.review_url, updated_at=datetime('now')`
    )
    .run(officeId, officeName, place_id, review_url);
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

interface JobForReview {
  id: number;
  number: string | null;
  kind: string | null;
  completed_at: string | null;
  office_id: string | null;
  office_name: string | null;
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
      `SELECT j.id, j.number, j.kind, j.completed_at, j.office_id, j.office_name,
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

function buildMessage(job: JobForReview): { subject: string; body: string; html: string } {
  const first = (job.contact_name || '').split(/\s+/)[0] || 'there';
  const office = job.office_name || COMPANY.name;
  const work = (job.kind || 'service').toLowerCase();
  const subject = `How did we do? — ${office}`;
  const body =
    `Hi ${first}, thanks for trusting ${COMPANY.name} (${office}) with your recent ${work}. ` +
    `If we did right by you, a quick Google review would mean a lot and helps other Texas businesses find us. ` +
    `It takes about a minute: ${job.review_url}\n\nThank you,\n${office} — ${COMPANY.name}`;
  const html =
    `<p>Hi ${escapeHtml(first)},</p>` +
    `<p>Thanks for trusting <b>${escapeHtml(COMPANY.name)}</b> (${escapeHtml(office)}) with your recent ${escapeHtml(work)}. ` +
    `If we did right by you, a quick Google review would mean a lot and helps other Texas businesses find us.</p>` +
    `<p><a href="${escapeAttr(job.review_url || '#')}" style="display:inline-block;background:#1E8E96;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Leave a review</a></p>` +
    `<p>Thank you,<br>${escapeHtml(office)} — ${escapeHtml(COMPANY.name)}</p>`;
  return { subject, body, html };
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/**
 * Queue a review request for one completed job. In 'auto' mode with mail configured it sends
 * immediately; otherwise it is held for review. Idempotent per job (marks review_requested).
 */
export async function queueReviewRequest(jobId: number, opts: { forceSend?: boolean } = {}): Promise<{ ok: boolean; status: string; error?: string }> {
  const db = getDb();
  const job = pendingReviewJobs(100000).find((j) => j.id === jobId);
  if (!job) return { ok: false, status: 'skipped', error: 'job not eligible (no mapped office, no contact, or already requested)' };
  if (!job.contact_email) return { ok: false, status: 'skipped', error: 'no contact email' };
  if (recentlyAsked(job.contact_email)) {
    db.prepare(`UPDATE crm_jobs SET review_requested = 1 WHERE id = ?`).run(jobId);
    return { ok: false, status: 'skipped', error: 'contact already asked within 90 days' };
  }

  const { subject, body, html } = buildMessage(job);
  const auto = opts.forceSend || getMode() === 'auto';
  let status = auto ? 'approved' : 'held';
  let sentAt: string | null = null;
  let error: string | null = null;

  if (auto && mailConfigured()) {
    const r = await sendMail(job.contact_email, subject, html);
    if (r.ok) { status = 'sent'; sentAt = new Date().toISOString(); }
    else { status = 'approved'; error = r.error || 'send failed'; }
  }

  db.prepare(
    `INSERT INTO review_requests (job_id, customer, job_desc, channel, body, status, office_name, review_url,
       recipient_email, recipient_phone, subject, sent_at, error, source)
     VALUES (?, ?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'servicetrade')`
  ).run(
    jobId, job.account_name || job.contact_name || 'Customer', job.kind || null, body, status,
    job.office_name || null, job.review_url || null, job.contact_email, job.contact_phone || null,
    subject, sentAt, error
  );
  db.prepare(`UPDATE crm_jobs SET review_requested = 1 WHERE id = ?`).run(jobId);
  return { ok: true, status, error: error || undefined };
}

/** Sweep newly completed jobs into requests. Returns per-status counts. Bounded per run. */
export async function runReviewSweep(max = 200): Promise<{ queued: number; sent: number; held: number; skipped: number }> {
  const jobs = pendingReviewJobs(max);
  let sent = 0, held = 0, skipped = 0, queued = 0;
  for (const j of jobs) {
    const r = await queueReviewRequest(j.id);
    if (!r.ok) { skipped++; continue; }
    queued++;
    if (r.status === 'sent') sent++;
    else held++;
  }
  return { queued, sent, held, skipped };
}

/** Send a specific held/approved request now (the manual "approve & send"). */
export async function sendReviewRequest(id: number): Promise<{ ok: boolean; status: string; error?: string }> {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM review_requests WHERE id = ?`).get(id) as any;
  if (!r) return { ok: false, status: 'error', error: 'request not found' };
  if (r.status === 'sent') return { ok: true, status: 'sent' };
  if (!r.recipient_email) return { ok: false, status: 'error', error: 'no recipient email' };
  const subject = r.subject || `How did we do? — ${r.office_name || COMPANY.name}`;
  const html = (r.body || '').replace(/\n/g, '<br>');
  const res = await sendMail(r.recipient_email, subject, html);
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
    held: n(`SELECT COUNT(*) AS v FROM review_requests WHERE source='servicetrade' AND status='held'`),
    sent: n(`SELECT COUNT(*) AS v FROM review_requests WHERE source='servicetrade' AND status='sent'`),
  };
}
