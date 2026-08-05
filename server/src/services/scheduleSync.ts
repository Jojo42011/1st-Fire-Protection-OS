import { getDb } from '../db/index';
import { stGet, stConfigured } from './servicetrade';

/**
 * Schedule sync: pull SCHEDULED ServiceTrade appointments in a rolling window (last week through
 * three weeks out), with the technicians ServiceTrade has assigned, and mirror them into
 * sched_appointments + sched_appt_techs so the Dispatcher can render a real crew-week grid.
 * Read-only. Rebuilds the window each run (clean replace), so cancellations drop out naturally.
 */

interface StTech { id: number | string; name?: string; firstName?: string }
interface StAppt {
  id: number | string;
  status?: string;
  windowStart?: number; windowEnd?: number;
  updated?: number;
  job?: { id?: number | string; number?: string | number; type?: string; name?: string };
  location?: { name?: string };
  offices?: { name?: string }[];
  techs?: StTech[];
}

const isoFromUnix = (u?: number): string | null => (u ? new Date(u * 1000).toISOString() : null);

/** Has the schedule mirror been populated at least once? */
export function hasSchedule(): boolean {
  const n = (getDb().prepare(`SELECT COUNT(*) AS v FROM sched_appointments`).get() as { v: number }).v || 0;
  return n > 0;
}

export async function syncSchedule(daysBack = 7, daysAhead = 21): Promise<{ appointments: number; techLinks: number }> {
  if (!stConfigured()) return { appointments: 0, techLinks: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  const from = nowSec - daysBack * 86400;
  const to = nowSec + daysAhead * 86400;

  const all: StAppt[] = [];
  let page = 1, totalPages = 1, guard = 0;
  while (page <= totalPages && guard++ < 30) {
    const r: any = await stGet(`/appointment?status=scheduled&windowBeginsAfter=${from}&windowBeginsBefore=${to}&limit=200&page=${page}`);
    const d = r?.data || r;
    const arr: StAppt[] = d?.appointments || [];
    totalPages = Number(d?.totalPages || 1);
    all.push(...arr);
    page++;
    if (!arr.length) break;
  }

  const db = getDb();
  const insA = db.prepare(
    `INSERT OR REPLACE INTO sched_appointments
       (st_id, job_id, job_number, job_type, customer, location_name, office, window_start, window_end, status, st_updated_at, synced_at)
     VALUES (@st_id, @job_id, @job_number, @job_type, @customer, @location_name, @office, @window_start, @window_end, @status, @st_updated_at, datetime('now'))`
  );
  const insT = db.prepare(`INSERT INTO sched_appt_techs (appt_st_id, tech_id, tech_name, office) VALUES (?, ?, ?, ?)`);

  const rebuild = db.transaction((appts: StAppt[]) => {
    db.prepare(`DELETE FROM sched_appointments`).run();
    db.prepare(`DELETE FROM sched_appt_techs`).run();
    let techLinks = 0;
    for (const a of appts) {
      const office = a.offices?.[0]?.name || '';
      insA.run({
        st_id: String(a.id),
        job_id: a.job?.id ? String(a.job.id) : null,
        job_number: a.job?.number != null ? String(a.job.number) : null,
        job_type: a.job?.type || null,
        customer: a.location?.name || a.job?.name || null,
        location_name: a.location?.name || null,
        office,
        window_start: isoFromUnix(a.windowStart),
        window_end: isoFromUnix(a.windowEnd),
        status: a.status || 'scheduled',
        st_updated_at: isoFromUnix(a.updated),
      });
      for (const t of a.techs || []) {
        insT.run(String(a.id), String(t.id), t.name || t.firstName || `Tech ${t.id}`, office);
        techLinks++;
      }
    }
    return techLinks;
  });

  const techLinks = rebuild(all);
  return { appointments: all.length, techLinks };
}
