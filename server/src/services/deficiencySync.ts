import { getDb } from '../db/index';
import { stGet, stConfigured } from './servicetrade';
import { canonicalOffice } from '../os/office';

/**
 * Mirror the ServiceTrade open-deficiency backlog into a local table so the Deficiencies screen
 * and the office reports can read it fast and office-scoped. Deficiencies are the repair work techs
 * already found but that has not been quoted/converted yet: the clearest pile of recoverable revenue
 * in the ServiceTrade data.
 *
 * Office attribution is AUTHORITATIVE where possible: every deficiency belongs to a JOB, and a job
 * carries ServiceTrade's assignedOffice (mirrored into crm_jobs.office_name). So a deficiency's
 * office is its job's office. Only when the job's office is unknown (job not yet mirrored) do we fall
 * back to the service location's metro (cityToOffice). Deficiencies carry no dollar amount, so backlog
 * value is a clearly-labeled projection (open count x an assumed repair ticket).
 */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** ServiceTrade money comes back as a comma string ("9,415.00"); parse to a number. */
const money = (v: unknown): number => {
  const n = Number(String(v == null ? 0 : v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
/** Quote statuses that still count as an open (un-won) repair quote. */
const OPEN_QUOTE = ['draft', 'submitted', 'pending', 'reviewed', 'contingent'];

/**
 * Build a map of jobId -> best linked repair-quote value, from quotes whose `deficiencyJobs`
 * reference that job. Prefers an open (un-won) quote; falls back to any linked quote's total.
 */
async function repairQuoteValueByJob(): Promise<Map<number, number>> {
  const jobVal = new Map<number, number>();
  let page = 1;
  let totalPages = 1;
  let guard = 0;
  while (page <= totalPages && guard++ < 40) {
    const resp: any = await stGet(`/quote?limit=1000&page=${page}`);
    const d = resp?.data || resp;
    const qs = d?.quotes || d?.data || [];
    totalPages = num(d?.totalPages) || 1;
    for (const q of qs) {
      const dj = q?.deficiencyJobs || [];
      if (!dj.length) continue;
      const val = money(q.totalPrice);
      if (val <= 0) continue;
      const isOpen = OPEN_QUOTE.includes(String(q.status || '').toLowerCase());
      for (const j of dj) {
        const jid = (j && j.id) || j;
        if (jid == null) continue;
        const prev = jobVal.get(jid) || 0;
        // prefer the larger value; open quotes are the truest "not yet sold" repair dollars
        jobVal.set(jid, Math.max(prev, val));
        if (isOpen) jobVal.set(jid, Math.max(jobVal.get(jid) || 0, val));
      }
    }
    if (!qs.length) break;
    page++;
  }
  return jobVal;
}

/** Statuses that mean the deficiency is done/void and no longer part of the open backlog. */
export const CLOSED_STATUSES = ['fixed', 'invalid', 'canceled', 'cancelled', 'deleted', 'closed'];

/** Assumed average fire-repair ticket, used to PROJECT backlog value (deficiencies carry no price). */
export const AVG_REPAIR_USD = 650;

/**
 * City (from the deficiency's location address) -> canonical office key. Deficiencies carry no
 * assignedOffice in ServiceTrade, so office is attributed from the service location's metro. Values
 * are the OS canonical office keys (see os/office.ts) so deficiencies scope on the same identity as
 * every other object. Grouped by the real 1st FP service areas across Texas.
 *
 * NOTE: this metro map is a best-effort grouping of Texas cities to branches. If a city is served by
 * a different branch than assumed, correct it here (or, better, wire a ServiceTrade location->office
 * mapping when that data becomes available). Unmapped cities return null and the deficiency is left
 * unattributed rather than guessed.
 */
const CITY_OFFICE: Record<string, string> = {};
const seed = (office: string, cities: string[]) => cities.forEach((c) => (CITY_OFFICE[c] = office));
seed('austin', ['austin', 'san marcos', 'georgetown', 'lakeway', 'buda', 'round rock', 'dripping springs', 'cedar park', 'pflugerville', 'kyle', 'leander', 'bee cave', 'bastrop', 'elgin', 'taylor', 'hutto', 'burnet', 'marble falls', 'wimberley', 'lockhart', 'manor', 'del valle', 'liberty hill', 'jarrell', 'luling']);
// Services = the San Antonio HQ service branch (FPS).
seed('services', ['san antonio', 'boerne', 'new braunfels', 'schertz', 'seguin', 'converse', 'live oak', 'helotes', 'cibolo', 'floresville', 'kerrville', 'pleasanton', 'castroville', 'fair oaks ranch', 'selma', 'leon valley', 'devine', 'hondo', 'jourdanton', 'poteet', 'universal city', 'stone oak', 'alamo heights']);
// McAllen = the Rio Grande Valley branch.
seed('mcallen', ['mcallen', 'mission', 'edinburg', 'pharr', 'harlingen', 'brownsville', 'weslaco', 'mercedes', 'san juan', 'donna', 'rio grande city', 'los fresnos', 'la feria', 'elsa', 'raymondville', 'roma', 'penitas', 'palmview', 'hidalgo', 'alamo']);
// Waco = the central-Texas (Waco/Temple/Killeen) branch.
seed('waco', ['waco', 'temple', 'killeen', 'belton', 'hewitt', 'woodway', 'copperas cove', 'harker heights', 'robinson', 'mcgregor', 'gatesville', 'lorena', 'bellmead']);
seed('college-station', ['college station', 'bryan', 'huntsville', 'navasota', 'brenham', 'madisonville', 'caldwell', 'hearne', 'franklin']);
seed('lubbock', ['lubbock', 'amarillo', 'plainview', 'levelland', 'wolfforth', 'slaton', 'brownfield']);
seed('houston', ['houston', 'katy', 'sugar land', 'conroe', 'the woodlands', 'pearland', 'cypress', 'spring', 'humble', 'pasadena', 'baytown', 'galveston', 'tomball', 'richmond', 'rosenberg', 'friendswood', 'league city', 'stafford', 'missouri city', 'channelview', 'deer park']);
// Laredo = the Laredo / border branch.
seed('laredo', ['laredo', 'eagle pass', 'del rio', 'carrizo springs', 'zapata', 'cotulla']);

export function cityToOffice(city: string | null | undefined): string | null {
  if (!city) return null;
  return CITY_OFFICE[String(city).trim().toLowerCase()] || null;
}

/**
 * Attribute a deficiency to a canonical office key. Pure + testable.
 *   1. AUTHORITATIVE — the office assigned to the deficiency's job (assignedOffice from crm_jobs).
 *   2. FALLBACK      — the service location's metro (cityToOffice), only when the job office is unknown.
 * Returns { key: null } rather than guessing when neither signal resolves (never a fake office).
 */
export function attributeDeficiencyOffice(input: { jobOfficeName?: string | null; city?: string | null }): { key: string | null; via: 'job' | 'city' | 'none' } {
  const jobKey = canonicalOffice(input.jobOfficeName || '');
  if (jobKey) return { key: jobKey, via: 'job' };
  const cityKey = cityToOffice(input.city);
  if (cityKey) return { key: cityKey, via: 'city' };
  return { key: null, via: 'none' };
}

export async function syncDeficiencies(): Promise<{ pulled: number; open: number; attributed: number; viaJob: number; viaCity: number; unattributed: number; quoted: number; pages: number }> {
  if (!stConfigured()) throw new Error('ServiceTrade not connected');
  const db = getDb();

  const rows: any[] = [];
  let page = 1;
  let totalPages = 1;
  let guard = 0;
  while (page <= totalPages && guard++ < 80) {
    const resp: any = await stGet(`/deficiency?limit=1000&page=${page}`);
    const d = resp?.data || resp;
    const arr = d?.deficiencies || d?.data || (Array.isArray(d) ? d : []);
    totalPages = num(d?.totalPages) || 1;
    for (const x of arr) rows.push(x);
    if (!arr.length) break;
    page++;
  }

  const iso = (unix: unknown): string | null => {
    const n = num(unix);
    return n > 0 ? new Date(n * 1000).toISOString() : null;
  };
  const isOpen = (status: unknown) => !CLOSED_STATUSES.includes(String(status ?? '').toLowerCase());

  // Authoritative office attribution: map each mirrored job to its assignedOffice name.
  const jobOffice = new Map<number, string>();
  for (const r of db.prepare(`SELECT st_id, office_name FROM crm_jobs WHERE office_name IS NOT NULL AND office_name != ''`).all() as { st_id: string; office_name: string }[]) {
    const jid = num(r.st_id);
    if (jid > 0) jobOffice.set(jid, r.office_name);
  }

  // real repair dollars: link each deficiency's job to a quote (via the quote's deficiencyJobs)
  const jobVal = await repairQuoteValueByJob();
  // count OPEN deficiencies per job, so a quote covering several is split evenly (no double count)
  const openPerJob = new Map<number, number>();
  for (const x of rows) {
    const jid = x?.job?.id;
    if (jid != null && isOpen(x.status)) openPerJob.set(jid, (openPerJob.get(jid) || 0) + 1);
  }

  const upsert = db.prepare(
    `INSERT INTO deficiencies (st_id, account_id, company_st_id, job_st_id, company_name, location_name, description,
        status, severity, proposed_usd, quoted, office, reported_at, st_updated_at, source)
     VALUES (@st_id, NULL, NULL, @job_st_id, @company_name, @location_name, @description,
        @status, @severity, @proposed_usd, @quoted, @office, @reported_at, @st_updated_at, 'servicetrade')
     ON CONFLICT(st_id) DO UPDATE SET job_st_id=excluded.job_st_id, company_name=excluded.company_name,
        location_name=excluded.location_name, description=excluded.description, status=excluded.status,
        severity=excluded.severity, proposed_usd=excluded.proposed_usd, quoted=excluded.quoted,
        office=excluded.office, reported_at=excluded.reported_at, st_updated_at=excluded.st_updated_at, source='servicetrade'`
  );

  let attributed = 0;
  let quotedCount = 0;
  let viaJob = 0;
  let viaCity = 0;
  const tx = db.transaction((items: any[]) => {
    db.prepare(`DELETE FROM deficiencies WHERE source = 'servicetrade'`).run(); // clean rebuild
    for (const x of items) {
      if (x?.id == null) continue;
      const loc = x.location || {};
      const city = loc.address ? loc.address.city : null;
      const jid = x?.job?.id ?? null;
      // Authoritative: the deficiency's job's assignedOffice; fallback: the location metro.
      const attr = attributeDeficiencyOffice({ jobOfficeName: jid != null ? jobOffice.get(num(jid)) : null, city });
      const office = attr.key;
      if (office) { attributed++; if (attr.via === 'job') viaJob++; else if (attr.via === 'city') viaCity++; }
      const open = isOpen(x.status);
      // real quoted value, split across the open deficiencies sharing that quote's job
      let proposed = 0;
      if (open && jid != null && jobVal.has(jid)) {
        const share = openPerJob.get(jid) || 1;
        proposed = jobVal.get(jid)! / share;
      }
      const quoted = proposed > 0 ? 1 : 0;
      if (quoted) quotedCount++;
      upsert.run({
        st_id: x.id,
        job_st_id: jid,
        company_name: loc.name || null, // the site is the customer-facing name
        location_name: loc.address ? [loc.address.city, loc.address.state].filter(Boolean).join(', ') : null,
        description: x.title || x.description || x.proposedFix || null,
        status: String(x.status ?? 'unknown'),
        severity: x.severity != null ? String(x.severity) : null,
        proposed_usd: Math.round(proposed),
        quoted,
        office,
        reported_at: iso(x.reportedOn ?? x.created),
        st_updated_at: iso(x.updated),
      });
    }
  });
  tx(rows);

  const open = (db
    .prepare(`SELECT COUNT(*) AS v FROM deficiencies WHERE lower(status) NOT IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(',')})`)
    .get() as { v: number }).v;
  return { pulled: rows.length, open, attributed, viaJob, viaCity, unattributed: rows.length - attributed, quoted: quotedCount, pages: totalPages };
}

export function hasDeficiencies(): boolean {
  try {
    return (getDb().prepare(`SELECT COUNT(*) AS v FROM deficiencies`).get() as { v: number }).v > 0;
  } catch {
    return false;
  }
}
