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

const idOf = (obj: any): string | null => (obj && obj.id != null ? String(obj.id) : null);

function formatAddress(a: any): string {
  if (!a || typeof a !== 'object') return '';
  const parts = [a.street, a.city, a.state, a.postalCode].filter((x) => x && String(x).trim());
  return parts.join(', ');
}

interface StLocation {
  id: number;
  name?: string;
  status?: string;
  address?: any;
  company?: { id?: number };
  updated?: number;
}

/** Pull sites (ServiceTrade "locations") and link each to its parent account. Read-only safe. */
export async function pullSites(): Promise<{ pulled: number; linked: number; pages: number }> {
  const db = getDb();
  const acctByStId = db.prepare(`SELECT id FROM accounts WHERE st_id = ?`);
  const upsert = db.prepare(
    `INSERT INTO sites (st_id, account_id, name, address, st_updated_at, local_updated_at, sync_state)
     VALUES (@st_id, @account_id, @name, @address, @updated, datetime('now'), 'clean')
     ON CONFLICT(st_id) DO UPDATE SET
       account_id = excluded.account_id, name = excluded.name, address = excluded.address,
       st_updated_at = excluded.st_updated_at, local_updated_at = datetime('now')`
  );

  let page = 1;
  let totalPages = 1;
  let pulled = 0;
  let linked = 0;
  do {
    const resp = await stGet(`/location?isCustomer=true&page=${page}`);
    const { rows, totalPages: tp } = unwrap<StLocation>(resp, 'locations');
    totalPages = tp;
    const tx = db.transaction((locs: StLocation[]) => {
      for (const l of locs) {
        if (l?.id == null) continue;
        const companyStId = idOf(l.company);
        const acct = companyStId ? (acctByStId.get(companyStId) as { id: number } | undefined) : undefined;
        if (!acct) continue; // a site whose parent account isn't in our mirror is skipped
        linked++;
        upsert.run({
          st_id: String(l.id),
          account_id: acct.id,
          name: l.name || '(unnamed site)',
          address: formatAddress(l.address),
          updated: isoFromUnix(l.updated),
        });
        pulled++;
      }
    });
    tx(rows);
    page++;
  } while (page <= totalPages && page <= 500);

  setState('st_sites_pulled', '1');
  try {
    db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', ?, 'applied', 'sites')`).run(
      `Pulled ${pulled} sites from ServiceTrade (${linked} linked to accounts)`
    );
  } catch {
    /* best-effort */
  }
  return { pulled, linked, pages: totalPages };
}

interface StInvoice {
  id: number;
  status?: string;
  paid?: boolean;
  totalPrice?: number;
  totalPaidAmount?: number;
  dueDate?: number | null;
  customer?: { id?: number };
}

/**
 * Pull invoices and roll them up into each account's real balance/lifetime, flagging accounts
 * with a past-due unpaid invoice as at-risk. Read-only safe (GET only). Note: the Invoice
 * Collector's own AR source will be Sage Intacct later — this pull is CRM enrichment (balances
 * on the Accounts screen), not the collector's operating table.
 */
export async function pullInvoices(): Promise<{ pulled: number; accountsUpdated: number; pages: number }> {
  const db = getDb();
  const nowSec = Math.floor(Date.now() / 1000);

  // Aggregate in memory by customer st_id, then write once per account.
  const agg = new Map<string, { outstanding: number; lifetime: number; overdue: boolean }>();
  let page = 1;
  let totalPages = 1;
  let pulled = 0;
  do {
    const resp = await stGet(`/invoice?page=${page}`);
    const { rows, totalPages: tp } = unwrap<StInvoice>(resp, 'invoices');
    totalPages = tp;
    for (const inv of rows) {
      const cust = idOf(inv.customer);
      if (!cust) continue;
      const total = Number(inv.totalPrice) || 0;
      const paidAmt = Number(inv.totalPaidAmount) || 0;
      const open = Math.max(0, total - paidAmt);
      const isPaid = inv.paid === true || open === 0;
      const entry = agg.get(cust) || { outstanding: 0, lifetime: 0, overdue: false };
      entry.lifetime += total;
      if (!isPaid) {
        entry.outstanding += open;
        if (inv.dueDate != null && Number(inv.dueDate) < nowSec) entry.overdue = true;
      }
      agg.set(cust, entry);
      pulled++;
    }
    page++;
  } while (page <= totalPages && page <= 500);

  const update = db.prepare(
    `UPDATE accounts SET balance_cents = @balance, lifetime_cents = @lifetime,
       risk = @risk, local_updated_at = datetime('now')
     WHERE st_id = @st_id AND source = 'servicetrade'`
  );
  let accountsUpdated = 0;
  const tx = db.transaction(() => {
    for (const [stId, v] of agg) {
      const r = update.run({
        st_id: stId,
        balance: Math.round(v.outstanding * 100),
        lifetime: Math.round(v.lifetime * 100),
        risk: v.overdue ? 'at_risk' : null,
      });
      if (r.changes) accountsUpdated++;
    }
  });
  tx();

  setState('st_invoices_pulled', '1');
  try {
    db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', ?, 'applied', 'invoices')`).run(
      `Pulled ${pulled} invoices from ServiceTrade → ${accountsUpdated} account balances updated`
    );
  } catch {
    /* best-effort */
  }
  return { pulled, accountsUpdated, pages: totalPages };
}
