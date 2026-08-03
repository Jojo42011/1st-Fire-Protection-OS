import { getDb } from '../db/index';
import { setState } from '../db/schema';
import { stGet } from './servicetrade';

/**
 * The pull path — reads real records FROM ServiceTrade into our local mirror tables. Every call
 * here is a GET (allowed in read-only); it only writes to our own SQLite, never back to
 * ServiceTrade. Records land tagged source='servicetrade' so the screens can show real data
 * without disturbing the keyless demo seed.
 *
 * ServiceTrade wraps list results in a { data: { totalPages, page, <entity>: [...] } } envelope.
 */

const isoFromUnix = (s?: number | null): string | null => (s ? new Date(s * 1000).toISOString() : null);

function unwrap<T = any>(resp: any, key: string): { rows: T[]; totalPages: number } {
  const body = resp?.data ?? resp ?? {};
  return { rows: (body[key] as T[]) || [], totalPages: Number(body.totalPages) || 1 };
}

interface StCompany {
  id: number;
  name?: string;
  status?: string;
  created?: number;
  updated?: number;
  tags?: Array<{ name?: string } | string>;
}

const firstTag = (tags?: StCompany['tags']): string => {
  if (!Array.isArray(tags) || !tags.length) return '';
  const t = tags[0];
  return (typeof t === 'string' ? t : t?.name || '').toString();
};

/** Pull every customer company from ServiceTrade into the accounts mirror. Read-only safe. */
export async function pullAccounts(): Promise<{ pulled: number; pages: number }> {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO accounts (st_id, name, segment, customer_since, st_updated_at, local_updated_at, sync_state, source)
     VALUES (@st_id, @name, @segment, @since, @updated, datetime('now'), 'clean', 'servicetrade')
     ON CONFLICT(st_id) DO UPDATE SET
       name = excluded.name,
       segment = excluded.segment,
       customer_since = excluded.customer_since,
       st_updated_at = excluded.st_updated_at,
       local_updated_at = datetime('now'),
       source = 'servicetrade'`
  );

  let page = 1;
  let totalPages = 1;
  let pulled = 0;
  do {
    const resp = await stGet(`/company?isCustomer=true&page=${page}`);
    const { rows, totalPages: tp } = unwrap<StCompany>(resp, 'companies');
    totalPages = tp;
    const tx = db.transaction((companies: StCompany[]) => {
      for (const c of companies) {
        if (c?.id == null) continue;
        upsert.run({
          st_id: String(c.id),
          name: c.name || '(unnamed)',
          segment: firstTag(c.tags),
          since: (isoFromUnix(c.created) || '').slice(0, 10),
          updated: isoFromUnix(c.updated),
        });
        pulled++;
      }
    });
    tx(rows);
    page++;
  } while (page <= totalPages && page <= 200); // hard safety cap on pages

  setState('st_accounts_pulled', '1');
  try {
    db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', ?, 'applied', 'accounts')`).run(
      `Pulled ${pulled} customers from ServiceTrade`
    );
  } catch {
    /* best-effort log */
  }
  return { pulled, pages: totalPages };
}

/** Have we pulled real accounts yet? Drives the screens' real-vs-demo switch. */
export function hasRealAccounts(): boolean {
  const row = getDb().prepare(`SELECT 1 FROM accounts WHERE source = 'servicetrade' LIMIT 1`).get();
  return !!row;
}
