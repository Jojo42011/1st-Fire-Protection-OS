import fs from 'fs';
import path from 'path';
import { getDb } from '../db/index';
import { REVIEW_OFFICES, ReviewOffice } from '../config/reviewOffices';

/**
 * The NFC review page: every employee badge opens /review, the customer taps their office, and the
 * link goes straight to that office's Google review form. Cards are server-rendered real links, so
 * the page works (and is instant) even before or without JavaScript; the script only adds motion and
 * the analytics events.
 */

export const REVIEW_EVENTS = ['landing_visit', 'office_selected', 'review_link_clicked'] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

export interface ResolvedOffice { slug: string; name: string; url: string }

const isGoogleReviewUrl = (u: string) => /^https:\/\/(g\.page|search\.google\.com|www\.google\.com|maps\.app\.goo\.gl|g\.co)\//i.test(u);

/** Offices with a usable link: config first, then the Review requests office mapping. */
export function resolveOffices(offices: ReviewOffice[] = REVIEW_OFFICES): ResolvedOffice[] {
  let mapped: { office_name: string | null; review_url: string | null }[] = [];
  try {
    mapped = getDb()
      .prepare(
        `SELECT COALESCE(NULLIF(t.office_name, ''), (SELECT MAX(j.office_name) FROM crm_jobs j WHERE j.office_id = t.office_id)) AS office_name,
                t.review_url
           FROM review_targets t WHERE t.review_url IS NOT NULL`
      )
      .all() as typeof mapped;
  } catch { /* table not ready: config only */ }
  const out: ResolvedOffice[] = [];
  for (const o of offices) {
    let url = (o.reviewUrl || '').trim();
    if (!url) {
      const hit = mapped.find((m) => (m.office_name || '').toLowerCase().includes(o.match.toLowerCase()));
      url = hit?.review_url?.trim() || '';
    }
    if (url && isGoogleReviewUrl(url)) out.push({ slug: o.slug, name: o.name, url });
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function officeCards(offices: ResolvedOffice[]): string {
  if (!offices.length) return '<li class="empty">Reviews are not set up yet. Please ask your technician for the office link.</li>';
  return offices
    .map(
      (o, i) => `<li style="--i:${i}"><a class="office" href="${esc(o.url)}" data-office="${esc(o.slug)}" aria-label="${esc(o.name)}: leave a Google review">
        <span class="pin" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 1 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/></svg></span>
        <span class="label"><span class="name">${esc(o.name)}</span><span class="state">Opening Google…</span></span>
        <span class="go" aria-hidden="true"><svg class="arrow" viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg><span class="spin"></span></span>
      </a></li>`
    )
    .join('\n      ');
}

let template: string | null = null;
function loadTemplate(): string {
  if (template && process.env.NODE_ENV === 'production') return template;
  template = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'client', 'review.html'), 'utf8');
  return template;
}

export function renderReviewPage(offices: ResolvedOffice[] = resolveOffices(), year = new Date().getFullYear()): string {
  return loadTemplate().replace('<!--OFFICES-->', officeCards(offices)).replace('<!--YEAR-->', String(year));
}

/* ---------------------------- analytics ---------------------------- */

const clean = (v: unknown, max: number) => String(v ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, max);

/** Validate and store one page event. Returns false (and stores nothing) for anything malformed. */
export function recordReviewEvent(body: any, userAgent = ''): boolean {
  const event = String(body?.event || '') as ReviewEvent;
  if (!REVIEW_EVENTS.includes(event)) return false;
  const office = clean(body?.office, 40);
  if (event !== 'landing_visit' && !REVIEW_OFFICES.some((o) => o.slug === office)) return false;
  getDb()
    .prepare(`INSERT INTO review_page_events (event, office, src, badge, session, mobile) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(event, office || null, clean(body?.src, 24) || null, clean(body?.badge, 40) || null, clean(body?.sid, 24) || null,
      /iphone|android|mobile/i.test(userAgent) ? 1 : 0);
  return true;
}

export function reviewPageStats(days = 30) {
  const db = getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const count = (event: ReviewEvent) =>
    (db.prepare(`SELECT COUNT(*) AS v FROM review_page_events WHERE event = ? AND created_at >= ?`).get(event, since) as { v: number }).v;
  const byOffice = db
    .prepare(
      `SELECT office,
              SUM(CASE WHEN event = 'office_selected' THEN 1 ELSE 0 END) AS selected,
              SUM(CASE WHEN event = 'review_link_clicked' THEN 1 ELSE 0 END) AS clicked
         FROM review_page_events WHERE office IS NOT NULL AND created_at >= ?
        GROUP BY office ORDER BY clicked DESC, selected DESC`
    )
    .all(since) as { office: string; selected: number; clicked: number }[];
  const byBadge = db
    .prepare(
      `SELECT badge, SUM(CASE WHEN event = 'landing_visit' THEN 1 ELSE 0 END) AS visits,
              SUM(CASE WHEN event = 'review_link_clicked' THEN 1 ELSE 0 END) AS clicked
         FROM review_page_events WHERE badge IS NOT NULL AND created_at >= ?
        GROUP BY badge ORDER BY clicked DESC, visits DESC LIMIT 25`
    )
    .all(since) as { badge: string; visits: number; clicked: number }[];
  const names = new Map(REVIEW_OFFICES.map((o) => [o.slug, o.name]));
  const shown = new Set(resolveOffices().map((o) => o.slug));
  const hidden = REVIEW_OFFICES.filter((o) => !shown.has(o.slug)).map((o) => o.name);
  return {
    ok: true as const,
    days,
    visits: count('landing_visit'),
    nfcVisits: (db.prepare(`SELECT COUNT(*) AS v FROM review_page_events WHERE event = 'landing_visit' AND src = 'nfc' AND created_at >= ?`).get(since) as { v: number }).v,
    selected: count('office_selected'),
    clicked: count('review_link_clicked'),
    byOffice: byOffice.map((r) => ({ ...r, name: names.get(r.office) || r.office })),
    byBadge,
    hidden,
  };
}
