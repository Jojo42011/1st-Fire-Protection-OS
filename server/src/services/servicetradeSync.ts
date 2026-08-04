import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { stGet, stConfigured } from './servicetrade';
import { runReviewSweep } from './reviewRequests';

/**
 * The pull path — reads real records FROM ServiceTrade into our local mirror tables. Every call
 * here is a GET (allowed in read-only); it only writes to our own SQLite, never back to
 * ServiceTrade. Records land tagged source='servicetrade' so the screens can show real data
 * without disturbing the keyless demo seed.
 *
 * ServiceTrade wraps list results in a { data: { totalPages, page, <entity>: [...] } } envelope.
 */

const isoFromUnix = (s?: number | null): string | null => (s ? new Date(s * 1000).toISOString() : null);

// ── background pull runner ──
// Big pulls (locations paginate ~10/page → hundreds of pages) can't ride a single HTTP
// request, so pulls run in the background: start one, poll status. One pull at a time.
const MAX_PAGES = 5000; // safety backstop, high enough not to truncate real data
type Entity = 'accounts' | 'sites' | 'invoices' | 'jobs' | 'quotes' | 'completed_jobs';
let runningEntity: Entity | null = null;
let progress: { page: number; totalPages: number; count: number } | null = null;
let lastStatus: { entity: Entity; state: 'done' | 'error'; counts?: any; error?: string; at: string } | null = null;

// Incremental cursors: the unix time of each entity's last successful sync. The next sync asks
// ServiceTrade only for records changed since (updatedAfter), so a refresh is seconds not minutes.
function cursorKey(e: Entity): string { return `st_cursor_${e}`; }
export function getCursor(entity: Entity): number | undefined {
  const v = getState(cursorKey(entity));
  return v ? Number(v) : undefined;
}
export function setCursor(entity: Entity, unixSec: number): void {
  setState(cursorKey(entity), String(unixSec));
}

export const isPulling = (): Entity | null => runningEntity;
export function pullStatus() {
  if (runningEntity) return { entity: runningEntity, state: 'running' as const, progress };
  return lastStatus;
}
export function startPull(entity: Entity): { started: boolean; busy?: boolean; entity: Entity } {
  if (runningEntity) return { started: false, busy: true, entity: runningEntity };
  runningEntity = entity;
  progress = { page: 0, totalPages: 1, count: 0 };
  const fn =
    entity === 'accounts' ? pullAccounts :
    entity === 'sites' ? pullSites :
    entity === 'invoices' ? pullInvoices :
    entity === 'jobs' ? pullJobs :
    pullQuotes;
  Promise.resolve()
    .then(() => fn())
    .then((counts) => {
      lastStatus = { entity, state: 'done', counts, at: new Date().toISOString() };
    })
    .catch((err) => {
      lastStatus = { entity, state: 'error', error: (err as Error).message, at: new Date().toISOString() };
    })
    .finally(() => {
      runningEntity = null;
      progress = null;
    });
  return { started: true, entity };
}

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

/** Pull customer companies into the accounts mirror. With `since`, only records changed after
 *  that unix time (incremental). Read-only safe. */
export async function pullAccounts(since?: number): Promise<{ pulled: number; pages: number }> {
  const db = getDb();
  const startedAt = Math.floor(Date.now() / 1000);
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
  const sinceQ = since ? `&updatedAfter=${since}` : '';
  do {
    const resp = await stGet(`/company?isCustomer=true&page=${page}${sinceQ}`);
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
    progress = { page, totalPages, count: pulled };
    page++;
  } while (page <= totalPages && page <= MAX_PAGES);

  setState('st_accounts_pulled', '1');
  setCursor('accounts', startedAt);
  try {
    db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', ?, 'applied', 'accounts')`).run(
      `${since ? 'Synced' : 'Pulled'} ${pulled} customer${pulled === 1 ? '' : 's'} from ServiceTrade`
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
/** Have we pulled real sites yet? */
export function hasRealSites(): boolean {
  const row = getDb().prepare(`SELECT 1 FROM sites WHERE source = 'servicetrade' LIMIT 1`).get();
  return !!row;
}
export function hasRealJobs(): boolean {
  return !!getDb().prepare(`SELECT 1 FROM crm_jobs WHERE source = 'servicetrade' LIMIT 1`).get();
}
export function hasRealQuotes(): boolean {
  return !!getDb().prepare(`SELECT 1 FROM quotes WHERE source = 'servicetrade' LIMIT 1`).get();
}

interface StJob {
  id: number; number?: number | null; name?: string; type?: string; status?: string; displayStatus?: string;
  serviceLine?: string; scheduledDate?: number | null; completedOn?: number | null;
  customer?: { id?: number }; location?: { id?: number }; updated?: number;
  assignedOffice?: { id?: number; name?: string } | null;
  primaryContact?: { firstName?: string; lastName?: string; email?: string; phone?: string; mobile?: string } | null;
}

/** Pull jobs into the crm_jobs mirror, linked to account + site. Incremental with `since`. */
export async function pullJobs(since?: number): Promise<{ pulled: number; pages: number }> {
  const db = getDb();
  const startedAt = Math.floor(Date.now() / 1000);
  const acctBy = db.prepare(`SELECT id FROM accounts WHERE st_id = ?`);
  const siteBy = db.prepare(`SELECT id FROM sites WHERE st_id = ?`);
  const upsert = db.prepare(
    `INSERT INTO crm_jobs (st_id, account_id, site_id, number, kind, status, scheduled_at, completed_at, st_updated_at, source,
       office_id, office_name, contact_name, contact_email, contact_phone)
     VALUES (@st_id, @account_id, @site_id, @number, @kind, @status, @sched, @completed, @updated, 'servicetrade',
       @office_id, @office_name, @contact_name, @contact_email, @contact_phone)
     ON CONFLICT(st_id) DO UPDATE SET account_id=excluded.account_id, site_id=excluded.site_id, number=excluded.number,
       kind=excluded.kind, status=excluded.status, scheduled_at=excluded.scheduled_at, completed_at=excluded.completed_at,
       st_updated_at=excluded.st_updated_at, source='servicetrade',
       office_id=excluded.office_id, office_name=excluded.office_name, contact_name=excluded.contact_name,
       contact_email=excluded.contact_email, contact_phone=excluded.contact_phone`
  );
  let page = 1, totalPages = 1, pulled = 0;
  const sinceQ = since ? `&updatedAfter=${since}` : '';
  do {
    const resp = await stGet(`/job?page=${page}${sinceQ}`);
    const { rows, totalPages: tp } = unwrap<StJob>(resp, 'jobs');
    totalPages = tp;
    const tx = db.transaction((js: StJob[]) => {
      for (const j of js) {
        if (j?.id == null) continue;
        const a = idOf(j.customer) ? (acctBy.get(idOf(j.customer)) as { id: number } | undefined) : undefined;
        const s = idOf(j.location) ? (siteBy.get(idOf(j.location)) as { id: number } | undefined) : undefined;
        const pc = j.primaryContact || null;
        const cname = pc ? [pc.firstName, pc.lastName].filter(Boolean).join(' ') || null : null;
        upsert.run({
          st_id: String(j.id), account_id: a ? a.id : null, site_id: s ? s.id : null,
          number: j.number != null ? String(j.number) : j.name || null,
          kind: j.serviceLine || j.type || null, status: j.displayStatus || j.status || null,
          sched: isoFromUnix(j.scheduledDate), completed: isoFromUnix(j.completedOn), updated: isoFromUnix(j.updated),
          office_id: j.assignedOffice && j.assignedOffice.id != null ? String(j.assignedOffice.id) : null,
          office_name: j.assignedOffice ? j.assignedOffice.name || null : null,
          contact_name: cname,
          contact_email: pc && pc.email ? String(pc.email).toLowerCase() : null,
          contact_phone: pc ? pc.mobile || pc.phone || null : null,
        });
        pulled++;
      }
    });
    tx(rows);
    progress = { page, totalPages, count: pulled };
    page++;
  } while (page <= totalPages && page <= MAX_PAGES);
  setState('st_jobs_pulled', '1');
  setCursor('jobs', startedAt);
  try { db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', ?, 'applied', 'jobs')`).run(`${since ? 'Synced' : 'Pulled'} ${pulled} job${pulled === 1 ? '' : 's'} from ServiceTrade`); } catch { /* */ }
  return { pulled, pages: totalPages };
}

/**
 * Pull COMPLETED jobs (the review-request trigger). The default /job list returns open jobs,
 * so we filter to completed and use longForm=true to get assignedOffice + primaryContact. On
 * first run it backfills the last ~90 days; after that it is incremental on updatedAfter.
 */
export async function pullCompletedJobs(since?: number): Promise<{ pulled: number; pages: number }> {
  const db = getDb();
  const startedAt = Math.floor(Date.now() / 1000);
  const acctBy = db.prepare(`SELECT id FROM accounts WHERE st_id = ?`);
  const siteBy = db.prepare(`SELECT id FROM sites WHERE st_id = ?`);
  const upsert = db.prepare(
    `INSERT INTO crm_jobs (st_id, account_id, site_id, number, kind, status, scheduled_at, completed_at, st_updated_at, source,
       office_id, office_name, contact_name, contact_email, contact_phone)
     VALUES (@st_id, @account_id, @site_id, @number, @kind, @status, @sched, @completed, @updated, 'servicetrade',
       @office_id, @office_name, @contact_name, @contact_email, @contact_phone)
     ON CONFLICT(st_id) DO UPDATE SET account_id=excluded.account_id, site_id=excluded.site_id, number=excluded.number,
       kind=excluded.kind, status=excluded.status, scheduled_at=excluded.scheduled_at, completed_at=excluded.completed_at,
       st_updated_at=excluded.st_updated_at, source='servicetrade',
       office_id=excluded.office_id, office_name=excluded.office_name, contact_name=excluded.contact_name,
       contact_email=excluded.contact_email, contact_phone=excluded.contact_phone`
  );
  const windowStart = since ? '' : `&completedOnBegin=${startedAt - 90 * 86400}`;
  const sinceQ = since ? `&updatedAfter=${since}` : '';
  let page = 1, totalPages = 1, pulled = 0;
  do {
    const resp = await stGet(`/job?status=*&longForm=true${windowStart}${sinceQ}&page=${page}`);
    const { rows, totalPages: tp } = unwrap<StJob>(resp, 'jobs');
    totalPages = tp;
    const tx = db.transaction((js: StJob[]) => {
      for (const j of js) {
        if (j?.id == null || j.completedOn == null) continue; // completed jobs only
        const a = idOf(j.customer) ? (acctBy.get(idOf(j.customer)) as { id: number } | undefined) : undefined;
        const s = idOf(j.location) ? (siteBy.get(idOf(j.location)) as { id: number } | undefined) : undefined;
        const pc = j.primaryContact || null;
        const cname = pc ? [pc.firstName, pc.lastName].filter(Boolean).join(' ') || null : null;
        upsert.run({
          st_id: String(j.id), account_id: a ? a.id : null, site_id: s ? s.id : null,
          number: j.number != null ? String(j.number) : j.name || null,
          kind: j.serviceLine || j.type || null, status: j.displayStatus || j.status || 'Completed',
          sched: isoFromUnix(j.scheduledDate), completed: isoFromUnix(j.completedOn), updated: isoFromUnix(j.updated),
          office_id: j.assignedOffice && j.assignedOffice.id != null ? String(j.assignedOffice.id) : null,
          office_name: j.assignedOffice ? j.assignedOffice.name || null : null,
          contact_name: cname,
          contact_email: pc && pc.email ? String(pc.email).toLowerCase() : null,
          contact_phone: pc ? pc.mobile || pc.phone || null : null,
        });
        pulled++;
      }
    });
    tx(rows);
    progress = { page, totalPages, count: pulled };
    page++;
  } while (page <= totalPages && page <= MAX_PAGES);
  setCursor('completed_jobs', startedAt);
  try { db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', ?, 'applied', 'jobs')`).run(`${since ? 'Synced' : 'Pulled'} ${pulled} completed job${pulled === 1 ? '' : 's'} from ServiceTrade`); } catch { /* */ }
  return { pulled, pages: totalPages };
}

interface StQuote {
  id: number; refNumber?: string; name?: string; status?: string; totalPrice?: string;
  customer?: { id?: number }; location?: { id?: number }; latestSubmission?: number | null; updated?: number;
}

/** Pull quotes into the quotes mirror, linked to account + site. Incremental with `since`. */
export async function pullQuotes(since?: number): Promise<{ pulled: number; pages: number }> {
  const db = getDb();
  const startedAt = Math.floor(Date.now() / 1000);
  const acctBy = db.prepare(`SELECT id FROM accounts WHERE st_id = ?`);
  const siteBy = db.prepare(`SELECT id FROM sites WHERE st_id = ?`);
  const upsert = db.prepare(
    `INSERT INTO quotes (st_id, account_id, site_id, number, title, amount_cents, stage, sent_at, st_updated_at, local_updated_at, sync_state, source)
     VALUES (@st_id, @account_id, @site_id, @number, @title, @amount, @stage, @sent, @updated, datetime('now'), 'clean', 'servicetrade')
     ON CONFLICT(st_id) DO UPDATE SET account_id=excluded.account_id, site_id=excluded.site_id, number=excluded.number,
       title=excluded.title, amount_cents=excluded.amount_cents, stage=excluded.stage, sent_at=excluded.sent_at,
       st_updated_at=excluded.st_updated_at, local_updated_at=datetime('now'), source='servicetrade'`
  );
  let page = 1, totalPages = 1, pulled = 0;
  const sinceQ = since ? `&updatedAfter=${since}` : '';
  do {
    const resp = await stGet(`/quote?page=${page}${sinceQ}`);
    const { rows, totalPages: tp } = unwrap<StQuote>(resp, 'quotes');
    totalPages = tp;
    const tx = db.transaction((qs: StQuote[]) => {
      for (const q of qs) {
        if (q?.id == null) continue;
        const a = idOf(q.customer) ? (acctBy.get(idOf(q.customer)) as { id: number } | undefined) : undefined;
        const s = idOf(q.location) ? (siteBy.get(idOf(q.location)) as { id: number } | undefined) : undefined;
        upsert.run({
          st_id: String(q.id), account_id: a ? a.id : null, site_id: s ? s.id : null,
          number: q.refNumber || String(q.id), title: q.name || '(untitled quote)',
          // totalPrice is a string and may be comma-grouped ("12,500.00") — strip commas so
          // parseFloat doesn't truncate high-value quotes to a few dollars.
          amount: Math.round((parseFloat(String(q.totalPrice || '0').replace(/,/g, '')) || 0) * 100),
          stage: q.status || 'quoted', sent: isoFromUnix(q.latestSubmission), updated: isoFromUnix(q.updated),
        });
        pulled++;
      }
    });
    tx(rows);
    progress = { page, totalPages, count: pulled };
    page++;
  } while (page <= totalPages && page <= MAX_PAGES);
  setState('st_quotes_pulled', '1');
  setCursor('quotes', startedAt);
  try { db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', ?, 'applied', 'quotes')`).run(`${since ? 'Synced' : 'Pulled'} ${pulled} quote${pulled === 1 ? '' : 's'} from ServiceTrade`); } catch { /* */ }
  return { pulled, pages: totalPages };
}

/**
 * The scheduled incremental sync. Accounts + sites refresh incrementally (only records changed
 * since their cursor — seconds, not the full 613-page site crawl); invoices re-pull in full
 * (cheap, 2 pages) so balances stay correct. Runs only when connected, never overlaps a manual
 * pull, and is entirely read-only. Skips an entity that was never fully pulled (no cursor yet).
 */
export async function runScheduledSync(): Promise<{ accounts?: any; sites?: any; invoices?: any } | null> {
  if (!stConfigured() || runningEntity) return null;
  const out: { accounts?: any; sites?: any; invoices?: any } = {};
  try {
    runningEntity = 'accounts';
    if (getCursor('accounts')) { progress = { page: 0, totalPages: 1, count: 0 }; out.accounts = await pullAccounts(getCursor('accounts')); }
    runningEntity = 'sites';
    if (getCursor('sites')) { progress = { page: 0, totalPages: 1, count: 0 }; out.sites = await pullSites(getCursor('sites')); }
    runningEntity = 'invoices';
    if (getCursor('invoices')) { progress = { page: 0, totalPages: 1, count: 0 }; out.invoices = await pullInvoices(); }
    runningEntity = 'jobs';
    if (getCursor('jobs')) { progress = { page: 0, totalPages: 1, count: 0 }; (out as any).jobs = await pullJobs(getCursor('jobs')); }
    runningEntity = 'quotes';
    if (getCursor('quotes')) { progress = { page: 0, totalPages: 1, count: 0 }; (out as any).quotes = await pullQuotes(getCursor('quotes')); }
    // Completed jobs (the review trigger) — incremental once the cursor is bootstrapped.
    if (getCursor('completed_jobs')) { runningEntity = 'jobs'; progress = { page: 0, totalPages: 1, count: 0 }; (out as any).completed = await pullCompletedJobs(getCursor('completed_jobs')); }
    // Newly-completed jobs flow into Google review requests (held or auto-sent per mode).
    try { (out as any).reviews = await runReviewSweep(); } catch { /* review sweep is best-effort */ }
    lastStatus = { entity: 'invoices', state: 'done', counts: out, at: new Date().toISOString() };
    return out;
  } catch (err) {
    lastStatus = { entity: runningEntity || 'accounts', state: 'error', error: (err as Error).message, at: new Date().toISOString() };
    return out;
  } finally {
    runningEntity = null;
    progress = null;
  }
}

// Debounced sync trigger for inbound webhooks — coalesces a burst of events into one sync run
// ~30s later, so real-time changes flow in without a sync per event.
let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
export function nudgeSync(): void {
  if (nudgeTimer) return;
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    void runScheduledSync().catch(() => {});
  }, 30000);
  if (typeof nudgeTimer.unref === 'function') nudgeTimer.unref();
}

/** Per-entity last-synced snapshot for the sync screen. */
export function syncSummary() {
  const db = getDb();
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE source = 'servicetrade'`).get() as { c: number }).c;
  const iso = (e: Entity) => { const c = getCursor(e); return c ? new Date(c * 1000).toISOString() : null; };
  return {
    connected: stConfigured(),
    entities: {
      accounts: { count: count('accounts'), lastSynced: iso('accounts') },
      sites: { count: count('sites'), lastSynced: iso('sites') },
      invoices: { lastSynced: iso('invoices') },
      jobs: { count: count('crm_jobs'), lastSynced: iso('jobs') },
      quotes: { count: count('quotes'), lastSynced: iso('quotes') },
    },
  };
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

/** Pull sites (ServiceTrade "locations"), linking each to its parent account. With `since`,
 *  only records changed after that unix time (incremental). Read-only safe. */
export async function pullSites(since?: number): Promise<{ pulled: number; linked: number; pages: number }> {
  const db = getDb();
  const startedAt = Math.floor(Date.now() / 1000);
  const acctByStId = db.prepare(`SELECT id FROM accounts WHERE st_id = ?`);
  const upsert = db.prepare(
    `INSERT INTO sites (st_id, account_id, name, address, st_updated_at, local_updated_at, sync_state, source)
     VALUES (@st_id, @account_id, @name, @address, @updated, datetime('now'), 'clean', 'servicetrade')
     ON CONFLICT(st_id) DO UPDATE SET
       account_id = excluded.account_id, name = excluded.name, address = excluded.address,
       st_updated_at = excluded.st_updated_at, local_updated_at = datetime('now'), source = 'servicetrade'`
  );

  let page = 1;
  let totalPages = 1;
  let pulled = 0;
  let linked = 0;
  const sinceQ = since ? `&updatedAfter=${since}` : '';
  do {
    const resp = await stGet(`/location?isCustomer=true&page=${page}${sinceQ}`);
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
    progress = { page, totalPages, count: pulled };
    page++;
  } while (page <= totalPages && page <= MAX_PAGES);

  setState('st_sites_pulled', '1');
  setCursor('sites', startedAt);
  try {
    db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', ?, 'applied', 'sites')`).run(
      `${since ? 'Synced' : 'Pulled'} ${pulled} site${pulled === 1 ? '' : 's'} from ServiceTrade (${linked} linked)`
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
  const startedAt = nowSec;

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
    progress = { page, totalPages, count: pulled };
    page++;
  } while (page <= totalPages && page <= MAX_PAGES);

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
  setCursor('invoices', startedAt);
  try {
    db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', ?, 'applied', 'invoices')`).run(
      `Pulled ${pulled} invoices from ServiceTrade → ${accountsUpdated} account balances updated`
    );
  } catch {
    /* best-effort */
  }
  return { pulled, accountsUpdated, pages: totalPages };
}
