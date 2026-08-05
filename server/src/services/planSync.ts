import { getDb } from '../db/index';
import { stGet, stConfigured } from './servicetrade';

/**
 * Service-plan sync: pull ServiceTrade recurring services (/servicerecurrence) into the mirror —
 * each is a location serviced on a cadence, i.e. a real recurring agreement. Read-only, rebuilt
 * each run. Office is then derived from the account's jobs (deriveRecurrenceOffices), same as quotes.
 */

interface StRecurrence {
  id: number | string;
  description?: string;
  serviceLine?: { name?: string; trade?: string; abbr?: string } | null;
  location?: { id?: number | string; name?: string } | null;
  frequency?: string; interval?: number;
  estimatedPrice?: string | number | null;
  firstStart?: number | null; endsOn?: number | null; updated?: number | null;
}

const isoFromUnix = (u?: number | null): string | null => (u ? new Date(u * 1000).toISOString() : null);

function perYearOf(frequency = '', interval = 1): number {
  const n = Math.max(1, interval || 1);
  switch ((frequency || '').toLowerCase()) {
    case 'daily': return 365 / n;
    case 'weekly': return 52 / n;
    case 'monthly': return 12 / n;
    case 'yearly': case 'annually': return 1 / n;
    default: return 1;
  }
}

function cadenceLabel(frequency = '', interval = 1): string {
  const f = (frequency || '').toLowerCase(); const n = interval || 1;
  if (f === 'monthly') return n === 1 ? 'Monthly' : n === 2 ? 'Bimonthly' : n === 3 ? 'Quarterly' : n === 6 ? 'Semi-annual' : n === 12 ? 'Annual' : `Every ${n} months`;
  if (f === 'yearly' || f === 'annually') return n === 1 ? 'Annual' : `Every ${n} years`;
  if (f === 'weekly') return n === 1 ? 'Weekly' : n === 2 ? 'Biweekly' : `Every ${n} weeks`;
  if (f === 'daily') return n === 1 ? 'Daily' : `Every ${n} days`;
  return frequency || 'Recurring';
}

export function hasPlans(): boolean {
  return ((getDb().prepare(`SELECT COUNT(*) AS v FROM service_recurrences`).get() as { v: number }).v || 0) > 0;
}

/** Derive each recurrence's office from its account's jobs (the recurrence itself carries no office). */
export function deriveRecurrenceOffices(): { updated: number } {
  const db = getDb();
  const info = db
    .prepare(
      `UPDATE service_recurrences
          SET office = (
            SELECT j.office_name FROM crm_jobs j
             WHERE j.account_id = service_recurrences.account_id AND j.office_name IS NOT NULL AND j.office_name != ''
             GROUP BY j.office_name ORDER BY COUNT(*) DESC LIMIT 1
          )
        WHERE account_id IS NOT NULL`
    )
    .run();
  return { updated: info.changes };
}

export async function syncPlans(): Promise<{ recurrences: number; officesSet: number }> {
  if (!stConfigured()) return { recurrences: 0, officesSet: 0 };
  const all: StRecurrence[] = [];
  let page = 1, totalPages = 1, guard = 0;
  while (page <= totalPages && guard++ < 60) {
    const r: any = await stGet(`/servicerecurrence?limit=200&page=${page}`);
    const d = r?.data || r;
    const arrKey = Object.keys(d || {}).find((k) => Array.isArray((d as any)[k]));
    const arr: StRecurrence[] = arrKey ? (d as any)[arrKey] : [];
    totalPages = Number(d?.totalPages || 1);
    all.push(...arr);
    page++;
    if (!arr.length) break;
  }

  const db = getDb();
  const acctBySite = db.prepare(`SELECT account_id FROM sites WHERE st_id = ?`);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO service_recurrences
       (st_id, description, location_id, location_name, account_id, service_line, trade, frequency, interval, per_year, cadence, price_cents, first_start, ends_on, st_updated_at, synced_at)
     VALUES (@st_id, @description, @location_id, @location_name, @account_id, @service_line, @trade, @frequency, @interval, @per_year, @cadence, @price_cents, @first_start, @ends_on, @st_updated_at, datetime('now'))`
  );

  const rebuild = db.transaction((recs: StRecurrence[]) => {
    db.prepare(`DELETE FROM service_recurrences`).run();
    for (const rec of recs) {
      const locId = rec.location?.id != null ? String(rec.location.id) : null;
      const acct = locId ? (acctBySite.get(locId) as { account_id: number } | undefined) : undefined;
      const price = parseFloat(String(rec.estimatedPrice ?? '0').replace(/,/g, '')) || 0;
      ins.run({
        st_id: String(rec.id),
        description: rec.description || null,
        location_id: locId,
        location_name: rec.location?.name || null,
        account_id: acct?.account_id ?? null,
        service_line: rec.serviceLine?.name || null,
        trade: rec.serviceLine?.trade || null,
        frequency: rec.frequency || null,
        interval: rec.interval || 1,
        per_year: perYearOf(rec.frequency, rec.interval),
        cadence: cadenceLabel(rec.frequency, rec.interval),
        price_cents: Math.round(price * 100),
        first_start: isoFromUnix(rec.firstStart),
        ends_on: isoFromUnix(rec.endsOn),
        st_updated_at: isoFromUnix(rec.updated),
      });
    }
  });
  rebuild(all);
  const { updated } = deriveRecurrenceOffices();
  return { recurrences: all.length, officesSet: updated };
}
