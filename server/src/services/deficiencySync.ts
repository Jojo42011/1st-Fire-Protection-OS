import { getDb } from '../db/index';
import { stGet, stConfigured } from './servicetrade';

/**
 * Mirror the ServiceTrade open-deficiency backlog into a local table so the Repair-backlog screen
 * and the office scoreboard can read it fast and office-scoped. Deficiencies are the repair work
 * techs already found but that has not been quoted/converted yet: the clearest pile of recoverable
 * revenue in the ServiceTrade data. Read-only pull; office is derived from the account's jobs,
 * the same proxy quotes use (ServiceTrade does not stamp an office on a deficiency).
 */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const idOf = (o: any): number | null => (o && typeof o === 'object' ? (o.id ?? null) : o ?? null);

/** Statuses that mean the deficiency is done/void and no longer part of the open backlog. */
export const CLOSED_STATUSES = ['fixed', 'invalid', 'canceled', 'cancelled', 'deleted', 'closed'];

export async function syncDeficiencies(): Promise<{ pulled: number; open: number; pages: number }> {
  if (!stConfigured()) throw new Error('ServiceTrade not connected');
  const db = getDb();
  const acctBy = db.prepare(`SELECT id FROM accounts WHERE st_id = ?`);

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
        status, severity, proposed_usd, reported_at, st_updated_at, source)
     VALUES (@st_id, @account_id, @company_st_id, @company_name, @location_name, @description,
        @status, @severity, @proposed_usd, @reported_at, @st_updated_at, 'servicetrade')
     ON CONFLICT(st_id) DO UPDATE SET account_id=excluded.account_id, company_st_id=excluded.company_st_id,
        company_name=excluded.company_name, location_name=excluded.location_name, description=excluded.description,
        status=excluded.status, severity=excluded.severity, proposed_usd=excluded.proposed_usd,
        reported_at=excluded.reported_at, st_updated_at=excluded.st_updated_at, source='servicetrade'`
  );

  const tx = db.transaction((items: any[]) => {
    // clean rebuild so fixed/removed deficiencies do not linger in the backlog
    db.prepare(`DELETE FROM deficiencies WHERE source = 'servicetrade'`).run();
    for (const x of items) {
      if (x?.id == null) continue;
      const companyStId = idOf(x.company);
      const acct = companyStId != null ? (acctBy.get(companyStId) as { id: number } | undefined) : undefined;
      upsert.run({
        st_id: x.id,
        account_id: acct ? acct.id : null,
        company_st_id: companyStId,
        company_name: (x.company && x.company.name) || x.orphanCompany || null,
        location_name: (x.location && x.location.name) || null,
        description: x.description || x.name || null,
        status: String(x.status ?? x.serviceStatus ?? 'unknown'),
        severity: x.severity != null ? String(x.severity) : null,
        proposed_usd: num(x.proposedProceeds ?? x.proposed_proceeds ?? x.estimatedProceeds),
        reported_at: iso(x.reportedOn ?? x.created),
        st_updated_at: iso(x.updated),
      });
    }
  });
  tx(rows);

  const derived = deriveDeficiencyOffices();
  const open = (db
    .prepare(
      `SELECT COUNT(*) AS v FROM deficiencies WHERE lower(status) NOT IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(',')})`
    )
    .get() as { v: number }).v;
  return { pulled: rows.length, open, pages: totalPages, ...(derived ? {} : {}) };
}

/** Inherit each deficiency's office from its account's jobs (the majority office_name). */
export function deriveDeficiencyOffices(): { updated: number } {
  const info = getDb()
    .prepare(
      `UPDATE deficiencies
          SET office = (
            SELECT j.office_name FROM crm_jobs j
             WHERE j.account_id = deficiencies.account_id AND j.office_name IS NOT NULL AND j.office_name != ''
             GROUP BY j.office_name ORDER BY COUNT(*) DESC LIMIT 1
          )
        WHERE account_id IS NOT NULL`
    )
    .run();
  return { updated: info.changes };
}

export function hasDeficiencies(): boolean {
  try {
    return (getDb().prepare(`SELECT COUNT(*) AS v FROM deficiencies`).get() as { v: number }).v > 0;
  } catch {
    return false;
  }
}
