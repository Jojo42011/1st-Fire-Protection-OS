import { getDb } from '../db/index';
import { stGet, stConfigured } from './servicetrade';

/**
 * Mirror the ServiceTrade open-deficiency backlog into a local table so the Repair-backlog screen
 * and the office scoreboard can read it fast and office-scoped. Deficiencies are the repair work
 * techs already found but that has not been quoted/converted yet: the clearest pile of recoverable
 * revenue in the ServiceTrade data.
 *
 * ServiceTrade deficiencies carry no company link and no dollar amount, but every one has a
 * location with an address, so office is attributed by the location's CITY (the only reliable
 * signal), and the backlog is sized by COUNT with a clearly-labeled projected value per repair.
 */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Statuses that mean the deficiency is done/void and no longer part of the open backlog. */
export const CLOSED_STATUSES = ['fixed', 'invalid', 'canceled', 'cancelled', 'deleted', 'closed'];

/** Assumed average fire-repair ticket, used to PROJECT backlog value (deficiencies carry no price). */
export const AVG_REPAIR_USD = 650;

/** City (from the deficiency's location address) -> friendly office label. Metros grouped. */
const CITY_OFFICE: Record<string, string> = {};
const seed = (office: string, cities: string[]) => cities.forEach((c) => (CITY_OFFICE[c] = office));
seed('Austin', ['austin', 'san marcos', 'georgetown', 'lakeway', 'buda', 'round rock', 'dripping springs', 'cedar park', 'pflugerville', 'kyle', 'leander', 'bee cave', 'bastrop', 'elgin', 'taylor', 'hutto', 'burnet', 'marble falls', 'wimberley', 'lockhart', 'manor', 'del valle', 'liberty hill', 'jarrell', 'luling']);
seed('San Antonio', ['san antonio', 'boerne', 'new braunfels', 'schertz', 'seguin', 'converse', 'universal city', 'live oak', 'helotes', 'cibolo', 'floresville', 'kerrville', 'pleasanton', 'castroville', 'fair oaks ranch', 'selma', 'leon valley', 'san marcos ', 'devine', 'hondo', 'jourdanton', 'poteet']);
seed('McAllen', ['mcallen', 'mission', 'edinburg', 'pharr', 'harlingen', 'brownsville', 'weslaco', 'mercedes', 'san juan', 'donna', 'alamo', 'rio grande city', 'los fresnos', 'la feria', 'elsa', 'raymondville', 'roma', 'penitas', 'palmview', 'hidalgo']);
seed('Waco', ['waco', 'temple', 'killeen', 'belton', 'hewitt', 'woodway', 'copperas cove', 'harker heights', 'robinson', 'mcgregor', 'gatesville', 'lorena', 'bellmead']);
seed('College Station', ['college station', 'bryan', 'huntsville', 'navasota', 'brenham', 'madisonville', 'caldwell', 'hearne', 'franklin']);
seed('Lubbock', ['lubbock', 'amarillo', 'plainview', 'levelland', 'wolfforth', 'slaton', 'brownfield']);
seed('Houston', ['houston', 'katy', 'sugar land', 'conroe', 'the woodlands', 'pearland', 'cypress', 'spring', 'humble', 'pasadena', 'baytown', 'galveston', 'tomball', 'richmond', 'rosenberg', 'friendswood', 'league city', 'stafford', 'missouri city', 'channelview', 'deer park']);
seed('Laredo', ['laredo', 'eagle pass', 'del rio', 'carrizo springs', 'zapata', 'cotulla']);

export function cityToOffice(city: string | null | undefined): string | null {
  if (!city) return null;
  return CITY_OFFICE[String(city).trim().toLowerCase()] || null;
}

export async function syncDeficiencies(): Promise<{ pulled: number; open: number; attributed: number; pages: number }> {
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

  const upsert = db.prepare(
    `INSERT INTO deficiencies (st_id, account_id, company_st_id, company_name, location_name, description,
        status, severity, proposed_usd, office, reported_at, st_updated_at, source)
     VALUES (@st_id, NULL, NULL, @company_name, @location_name, @description,
        @status, @severity, @proposed_usd, @office, @reported_at, @st_updated_at, 'servicetrade')
     ON CONFLICT(st_id) DO UPDATE SET company_name=excluded.company_name, location_name=excluded.location_name,
        description=excluded.description, status=excluded.status, severity=excluded.severity,
        proposed_usd=excluded.proposed_usd, office=excluded.office, reported_at=excluded.reported_at,
        st_updated_at=excluded.st_updated_at, source='servicetrade'`
  );

  let attributed = 0;
  const tx = db.transaction((items: any[]) => {
    db.prepare(`DELETE FROM deficiencies WHERE source = 'servicetrade'`).run(); // clean rebuild
    for (const x of items) {
      if (x?.id == null) continue;
      const loc = x.location || {};
      const city = loc.address ? loc.address.city : null;
      const office = cityToOffice(city);
      if (office) attributed++;
      upsert.run({
        st_id: x.id,
        company_name: loc.name || null, // the site is the customer-facing name
        location_name: loc.address ? [loc.address.city, loc.address.state].filter(Boolean).join(', ') : null,
        description: x.title || x.description || x.proposedFix || null,
        status: String(x.status ?? 'unknown'),
        severity: x.severity != null ? String(x.severity) : null,
        proposed_usd: num(x.proposedProceeds), // ServiceTrade rarely sets this; kept for when it does
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
  return { pulled: rows.length, open, attributed, pages: totalPages };
}

export function hasDeficiencies(): boolean {
  try {
    return (getDb().prepare(`SELECT COUNT(*) AS v FROM deficiencies`).get() as { v: number }).v > 0;
  } catch {
    return false;
  }
}
