import { getDb } from '../db/index';

/**
 * Analytics for the NFC review page. The page itself lives on the company website
 * (1stfpservices.com/review, repo devonbooker/1stfp, office links in src/data/reviewOffices.ts) and
 * sends its events here, so they show up on Reviews, then Review requests.
 */

export const REVIEW_PAGE_URL = (process.env.REVIEW_PAGE_URL || 'https://1stfpservices.com/review').replace(/\/$/, '');

export const REVIEW_EVENTS = ['landing_visit', 'office_selected', 'review_link_clicked'] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

const OFFICE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SPECIAL_NAMES: Record<string, string> = { mcallen: 'McAllen' };
/** "college-station" -> "College Station" (offices are defined on the website, not here). */
export function officeName(slug: string): string {
  return SPECIAL_NAMES[slug] || slug.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

const clean = (v: unknown, max: number) => String(v ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, max);

/** Accept the beacon body as an object, or as the JSON text the website sends (text/plain, so the
 *  cross-site request needs no preflight). */
export function parseEventBody(body: unknown): any {
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return null; } }
  return body;
}

export function recordReviewEvent(body: any, userAgent = ''): boolean {
  const event = String(body?.event || '') as ReviewEvent;
  if (!REVIEW_EVENTS.includes(event)) return false;
  const office = clean(body?.office, 40);
  if (event !== 'landing_visit' && !OFFICE_RE.test(office)) return false;
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
  return {
    ok: true as const,
    days,
    visits: count('landing_visit'),
    nfcVisits: (db.prepare(`SELECT COUNT(*) AS v FROM review_page_events WHERE event = 'landing_visit' AND src = 'nfc' AND created_at >= ?`).get(since) as { v: number }).v,
    selected: count('office_selected'),
    clicked: count('review_link_clicked'),
    byOffice: byOffice.map((r) => ({ ...r, name: officeName(r.office) })),
    byBadge,
    pageUrl: REVIEW_PAGE_URL,
  };
}
