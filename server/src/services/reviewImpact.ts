import { getDb } from '../db/index';
import { connectionInfo } from './googleBusiness';

/**
 * Reputation impact + request volume, before vs after, per office and company-wide.
 *
 * Two independent data sources, lined up by a normalized office key:
 *   - Reputation: the `reviews` table (Google Business Profile pulls). Each row carries stars,
 *     received_at and the Google location title. With per-review timestamps we can reconstruct the
 *     rating and count "as of" any date, so before/after needs no manual baseline snapshot.
 *   - Volume: the `review_requests` table (what the OS sent). Counted by office_name and sent_at.
 *
 * The company rollup sums both sources directly and never depends on the office-key join, so it is
 * always correct; the per-office table is best-effort (Google location titles and ServiceTrade
 * office names differ, e.g. "1st Fire Protection Austin" vs "1st FP Austin LLC", so both are reduced
 * to a city key). When Google is not connected the reputation columns are simply zero/empty and the
 * volume columns still work.
 */

/** Reduce a Google location title or a ServiceTrade office name to a comparable key (the city). */
export function officeKey(name: string | null | undefined): string {
  return String(name || '')
    .toLowerCase()
    .replace(/\bllc\b/g, ' ')
    .replace(/1st\s*fire\s*protection/g, ' ')
    .replace(/1st\s*fp/g, ' ')
    .replace(/\bservices?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface ReviewRow { stars: number | null; received_at: string | null; location: string | null }
interface SentRow { office_name: string | null; sent_at: string | null }

export interface OfficeImpact {
  key: string;
  label: string;
  // reputation
  reviewsBefore: number;
  reviewsNow: number;
  avgBefore: number | null;
  avgNow: number | null;
  landed: number;          // new reviews inside the window
  landedAvg: number | null; // avg stars of those new reviews
  // volume
  sentWindow: number;      // requests sent inside the window
  sentAllTime: number;
}

export interface ReviewImpactReport {
  ok: true;
  days: number;
  since: string;           // ISO date the window starts
  googleConnected: boolean; // real OAuth connection state (not "do we have reviews")
  googleConfigured: boolean; // OAuth client credentials present on the server
  reviewsSynced: number;    // how many Google reviews are stored (0 = connected but nothing pulled yet)
  company: {
    reviewsBefore: number; reviewsNow: number;
    avgBefore: number | null; avgNow: number | null;
    landed: number; landedAvg: number | null;
    sentWindow: number; sentAllTime: number;
  };
  offices: OfficeImpact[];
}

const round1 = (n: number | null): number | null => (n == null ? null : Math.round(n * 10) / 10);

/** Build the before/after reputation + volume report over the last `days` (default 90). */
export function reviewImpactReport(days = 90): ReviewImpactReport {
  const db = getDb();
  const d = Number.isFinite(days) && days > 0 ? Math.floor(days) : 90;
  const sinceMs = Date.now() - d * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();

  // Tolerant of a not-yet-migrated DB: a missing table yields no rows rather than a 500.
  const safeAll = <T>(sql: string): T[] => { try { return db.prepare(sql).all() as T[]; } catch { return []; } };
  const reviews = safeAll<ReviewRow>(`SELECT stars, received_at, location FROM reviews WHERE source = 'google' AND stars IS NOT NULL`);
  const sent = safeAll<SentRow>(`SELECT office_name, sent_at FROM review_requests WHERE source = 'servicetrade' AND status = 'sent' AND sent_at IS NOT NULL`);

  const parse = (s: string | null): number | null => {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  };

  // Accumulate per office key. A review with an unparseable date still counts toward "now" totals
  // (we know it exists) but cannot be placed relative to the window, so it is treated as "before".
  type Acc = { label: string; nowCount: number; nowSum: number; beforeCount: number; beforeSum: number; landed: number; landedSum: number; sentWindow: number; sentAll: number };
  const map = new Map<string, Acc>();
  const get = (key: string, label: string): Acc => {
    let a = map.get(key);
    if (!a) { a = { label, nowCount: 0, nowSum: 0, beforeCount: 0, beforeSum: 0, landed: 0, landedSum: 0, sentWindow: 0, sentAll: 0 }; map.set(key, a); }
    else if (!a.label && label) a.label = label;
    return a;
  };

  const company = { nowCount: 0, nowSum: 0, beforeCount: 0, beforeSum: 0, landed: 0, landedSum: 0, sentWindow: 0, sentAll: 0 };

  for (const r of reviews) {
    if (r.stars == null) continue;
    const key = officeKey(r.location) || '(unmatched)';
    const a = get(key, r.location || key);
    a.nowCount++; a.nowSum += r.stars;
    company.nowCount++; company.nowSum += r.stars;
    const t = parse(r.received_at);
    const inWindow = t != null && t >= sinceMs;
    if (inWindow) {
      a.landed++; a.landedSum += r.stars;
      company.landed++; company.landedSum += r.stars;
    } else {
      a.beforeCount++; a.beforeSum += r.stars;
      company.beforeCount++; company.beforeSum += r.stars;
    }
  }

  for (const s of sent) {
    const key = officeKey(s.office_name) || '(unmatched)';
    const a = get(key, s.office_name || key);
    a.sentAll++; company.sentAll++;
    const t = parse(s.sent_at);
    if (t != null && t >= sinceMs) { a.sentWindow++; company.sentWindow++; }
  }

  const avg = (sum: number, n: number): number | null => (n > 0 ? round1(sum / n) : null);

  const offices: OfficeImpact[] = [...map.entries()]
    .map(([key, a]) => ({
      key,
      label: a.label || key,
      reviewsBefore: a.beforeCount,
      reviewsNow: a.nowCount,
      avgBefore: avg(a.beforeSum, a.beforeCount),
      avgNow: avg(a.nowSum, a.nowCount),
      landed: a.landed,
      landedAvg: avg(a.landedSum, a.landed),
      sentWindow: a.sentWindow,
      sentAllTime: a.sentAll,
    }))
    // Show the busiest first: most reviews, then most sent.
    .sort((x, y) => y.reviewsNow - x.reviewsNow || y.sentAllTime - x.sentAllTime);

  const conn = (() => { try { return connectionInfo(); } catch { return { configured: false, connected: false }; } })();
  return {
    ok: true,
    days: d,
    since,
    googleConnected: !!conn.connected,
    googleConfigured: !!conn.configured,
    reviewsSynced: reviews.length,
    company: {
      reviewsBefore: company.beforeCount,
      reviewsNow: company.nowCount,
      avgBefore: avg(company.beforeSum, company.beforeCount),
      avgNow: avg(company.nowSum, company.nowCount),
      landed: company.landed,
      landedAvg: avg(company.landedSum, company.landed),
      sentWindow: company.sentWindow,
      sentAllTime: company.sentAll,
    },
    offices,
  };
}
