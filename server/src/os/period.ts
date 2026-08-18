/**
 * The OS time context: a small, closed set of reporting periods (Today, This week, ... This year,
 * Custom) resolved to an inclusive-start / exclusive-end ISO date range. Kept deliberately simple —
 * common workflows over dozens of filters. A period whose `dateColumn` is null on a metric is a
 * point-in-time snapshot ("as of now") and ignores the range.
 */
export type PeriodKey = 'today' | 'week' | 'month' | 'last_month' | 'quarter' | 'year' | 'all' | 'custom';

export interface DateRange {
  key: PeriodKey;
  start: string | null; // inclusive ISO date (YYYY-MM-DD), null = open start
  end: string | null;   // exclusive ISO date, null = open end
  label: string;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve a period key (+ optional custom start/end) to a concrete range. `now` is injectable for tests. */
export function resolvePeriod(key: string | undefined, opts: { start?: string; end?: string; now?: Date } = {}): DateRange {
  const now = opts.now || new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const startOfDay = new Date(Date.UTC(y, m, now.getUTCDate()));
  const tomorrow = new Date(startOfDay); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  switch ((key || 'month') as PeriodKey) {
    case 'today':
      return { key: 'today', start: iso(startOfDay), end: iso(tomorrow), label: 'Today' };
    case 'week': {
      const dow = (startOfDay.getUTCDay() + 6) % 7; // Monday = 0
      const monday = new Date(startOfDay); monday.setUTCDate(monday.getUTCDate() - dow);
      return { key: 'week', start: iso(monday), end: iso(tomorrow), label: 'This week' };
    }
    case 'last_month': {
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 1));
      return { key: 'last_month', start: iso(start), end: iso(end), label: 'Last month' };
    }
    case 'quarter': {
      const qStartMonth = Math.floor(m / 3) * 3;
      const start = new Date(Date.UTC(y, qStartMonth, 1));
      return { key: 'quarter', start: iso(start), end: iso(tomorrow), label: 'This quarter' };
    }
    case 'year': {
      const start = new Date(Date.UTC(y, 0, 1));
      return { key: 'year', start: iso(start), end: iso(tomorrow), label: 'This year' };
    }
    case 'all':
      return { key: 'all', start: null, end: null, label: 'All time' };
    case 'custom': {
      const s = opts.start && /^\d{4}-\d{2}-\d{2}$/.test(opts.start) ? opts.start : null;
      const e = opts.end && /^\d{4}-\d{2}-\d{2}$/.test(opts.end) ? opts.end : null;
      return { key: 'custom', start: s, end: e, label: 'Custom range' };
    }
    case 'month':
    default: {
      const start = new Date(Date.UTC(y, m, 1));
      return { key: 'month', start: iso(start), end: iso(tomorrow), label: 'This month' };
    }
  }
}

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'year', label: 'This year' },
  { key: 'all', label: 'All time' },
];
