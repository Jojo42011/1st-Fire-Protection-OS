import { Router } from 'express';
import { getDb } from '../db/index';
import { hasRealAccounts, hasRealSites, hasRealJobs, hasRealQuotes } from '../services/servicetradeSync';
import { runList, countWith, type ListSpec } from '../services/listQuery';
import { stGet, stConfigured } from '../services/servicetrade';

/**
 * CRM (Signal Phase 4) — Accounts, Account detail and Pipeline. Shell only: everything
 * serves the seeded fixtures and reports live:false. Stage changes queue a push through
 * sync_queue (never inline) and return optimistically.
 */
const router = Router();

const money = (cents: number): string =>
  '$' + Math.round((cents || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
const initials = (name: string): string =>
  name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
const fmtDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
};
const ago = (iso: string | null): string => {
  if (!iso) return '';
  const mins = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return Math.round(mins) + 'm ago';
  if (mins < 1440) return Math.round(mins / 60) + 'h ago';
  return Math.round(mins / 1440) + 'd ago';
};

const CONTRACT = (t: string | null) => (t === 'contract' ? 'Contract' : t === 'tm' ? 'T&M' : t === 'prospect' ? 'Prospect' : t || '');
const TOUCH = (k: string | null) =>
  ({ call: 'Call', autopilot: 'Autopilot', quote: 'Quote', job: 'Job done', review: 'Review', booked: 'Booked', invoice: 'Invoice' } as Record<string, string>)[
    k || ''
  ] || (k || '');

// Segment → monogram tint, matching the design.
const SEG_TINT: Record<string, [string, string]> = {
  Medical: ['var(--money-bg)', 'var(--money)'],
  Education: ['var(--amber-bg)', 'var(--amber-ink)'],
  Retail: ['var(--fill)', 'var(--ink-2)'],
  Industrial: ['var(--indigo-bg-2)', 'var(--indigo)'],
  Storage: ['var(--fill)', 'var(--ink-2)'],
  Government: ['var(--indigo-bg-2)', 'var(--indigo)'],
  Hospitality: ['var(--green-bg)', 'var(--green)'],
};

interface Acc {
  id: number; st_id: string; name: string; segment: string; contract_type: string;
  contract_renews_at: string | null; owner_user: string; customer_since: string;
  balance_cents: number; lifetime_cents: number; avg_days_to_pay: number | null;
  risk: string | null; last_touch_at: string | null; last_touch_kind: string | null;
}

// One row → the Accounts list display shape (shared by real + demo modes).
function mapAccount(db: ReturnType<typeof getDb>, a: Acc) {
  const sites = (db.prepare(`SELECT COUNT(*) AS v FROM sites WHERE account_id = ?`).get(a.id) as { v: number }).v;
  const nextSite = db
    .prepare(`SELECT next_service_at FROM sites WHERE account_id = ? AND next_service_at IS NOT NULL ORDER BY next_service_at ASC LIMIT 1`)
    .get(a.id) as { next_service_at: string } | undefined;
  const next = nextSite
    ? 'Inspection due ' + fmtDate(nextSite.next_service_at)
    : a.contract_type === 'prospect'
    ? 'Quote to send'
    : a.risk === 'at_risk'
    ? 'Overdue in ST'
    : a.balance_cents > 0
    ? 'Open balance (ST)'
    : 'Scheduled';
  const tint = SEG_TINT[a.segment] || ['var(--fill)', 'var(--ink-2)'];
  const seg = a.segment ? `${a.segment} · since ${a.customer_since || '—'}` : `Customer since ${a.customer_since || '—'}`;
  return {
    id: a.id,
    initials: initials(a.name),
    name: a.name,
    segment: seg,
    tintBg: tint[0],
    tintFg: tint[1],
    sites: sites ? `${sites} site${sites === 1 ? '' : 's'}` : '—',
    contract: CONTRACT(a.contract_type),
    contractKind: a.contract_type === 'prospect' ? 'indigo' : a.contract_type === 'tm' ? 'gray' : 'green',
    next,
    balance: money(a.balance_cents),
    balanceOverdue: a.balance_cents > 0 && a.risk === 'at_risk',
    touch: a.last_touch_kind === 'autopilot' ? 'Autopilot · today' : a.last_touch_kind ? `${TOUCH(a.last_touch_kind)} · ${ago(a.last_touch_at)}` : '—',
  };
}

// The list contract for real (ServiceTrade-backed) accounts: search by name, filter chips,
// sortable columns, paginated — all server-side.
const ACCOUNTS_SPEC: ListSpec = {
  table: 'accounts',
  baseWhere: "source = 'servicetrade'",
  searchCols: ['name'],
  filters: {
    all: '1 = 1',
    contract: "contract_type = 'contract'",
    due: 'balance_cents > 0',
    risk: "risk = 'at_risk'",
  },
  sorts: { name: 'name', balance: 'balance_cents', lifetime: 'lifetime_cents', since: 'customer_since' },
  defaultSort: 'name ASC',
};

router.get('/api/accounts', (req, res) => {
  const db = getDb();

  // Real mode: once ServiceTrade customers are pulled, the screen is fully server-driven —
  // search / filter / sort / paginate against the live data.
  if (hasRealAccounts()) {
    const result = runList<Acc>(ACCOUNTS_SPEC, {
      q: req.query.q as string,
      filter: req.query.filter as string,
      sort: req.query.sort as string,
      order: req.query.order as string,
      page: req.query.page as string,
      pageSize: req.query.pageSize as string,
    });
    const accounts = result.rows.map((a) => mapAccount(db, a));
    const counts = {
      all: countWith(ACCOUNTS_SPEC, 'all'),
      contract: countWith(ACCOUNTS_SPEC, 'contract'),
      due: countWith(ACCOUNTS_SPEC, 'due'),
      risk: countWith(ACCOUNTS_SPEC, 'risk'),
    };
    return res.json({
      accounts,
      counts,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      pages: result.pages,
      showing: accounts.length,
      live: true,
    });
  }

  // Demo mode (keyless): the seeded fixtures, unchanged.
  const filter = String(req.query.filter || 'all');
  const limit = Math.min(Number(req.query.pageSize) || Number(req.query.limit) || 8, 50);
  const all = db.prepare(`SELECT * FROM accounts ORDER BY id ASC`).all() as Acc[];
  const counts = { all: 412, contract: 118, due: 34, risk: all.filter((a) => a.risk === 'at_risk').length || 9 };
  let list = all;
  if (filter === 'contract') list = all.filter((a) => a.contract_type === 'contract');
  else if (filter === 'risk') list = all.filter((a) => a.risk === 'at_risk');
  const accounts = list.slice(0, limit).map((a) => mapAccount(db, a));
  res.json({ accounts, counts, total: 412, showing: accounts.length, page: 1, pages: 1, live: false });
});

// Sites at scale — the same server-side list contract over 6,130 records.
const SITES_SPEC: ListSpec = {
  table: 'sites',
  baseWhere: "source = 'servicetrade'",
  searchCols: ['name', 'address'],
  filters: { all: '1 = 1', linked: 'account_id IS NOT NULL', addressed: "address IS NOT NULL AND address != ''" },
  sorts: { name: 'name', account: 'account_id' },
  defaultSort: 'name ASC',
};

interface SiteRow {
  id: number; st_id: string | null; account_id: number | null; name: string | null;
  address: string | null; system_type: string | null; next_service_at: string | null;
}

router.get('/api/sites', (req, res) => {
  const db = getDb();

  if (hasRealSites()) {
    const result = runList<SiteRow>(SITES_SPEC, {
      q: req.query.q as string,
      filter: req.query.filter as string,
      sort: req.query.sort as string,
      order: req.query.order as string,
      page: req.query.page as string,
      pageSize: req.query.pageSize as string,
    });
    const nameOf = db.prepare(`SELECT name FROM accounts WHERE id = ?`);
    const sites = result.rows.map((s) => {
      const acc = s.account_id ? (nameOf.get(s.account_id) as { name: string } | undefined) : undefined;
      return {
        id: s.id,
        name: s.name || '(unnamed site)',
        address: s.address || '',
        account: acc?.name || '—',
        accountId: s.account_id,
        system: s.system_type || '',
        next: s.next_service_at ? 'Due ' + fmtDate(s.next_service_at) : '—',
      };
    });
    return res.json({
      sites,
      counts: { all: countWith(SITES_SPEC, 'all'), linked: countWith(SITES_SPEC, 'linked'), addressed: countWith(SITES_SPEC, 'addressed') },
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      pages: result.pages,
      showing: sites.length,
      live: true,
    });
  }

  // Demo mode: the seeded sites (few), joined to their seed accounts.
  const rows = db.prepare(`SELECT * FROM sites ORDER BY id ASC LIMIT 50`).all() as SiteRow[];
  const nameOf = db.prepare(`SELECT name FROM accounts WHERE id = ?`);
  const sites = rows.map((s) => {
    const acc = s.account_id ? (nameOf.get(s.account_id) as { name: string } | undefined) : undefined;
    return {
      id: s.id, name: s.name || '(unnamed site)', address: s.address || '', account: acc?.name || '—',
      accountId: s.account_id, system: s.system_type || '', next: s.next_service_at ? 'Due ' + fmtDate(s.next_service_at) : '—',
    };
  });
  res.json({ sites, counts: { all: rows.length, linked: rows.length, addressed: 0 }, total: rows.length, page: 1, pages: 1, showing: sites.length, live: false });
});

// Jobs at scale.
const JOBS_SPEC: ListSpec = {
  table: 'crm_jobs',
  baseWhere: "source = 'servicetrade'",
  searchCols: ['number', 'kind', 'status'],
  filters: { all: '1 = 1', open: 'completed_at IS NULL', completed: 'completed_at IS NOT NULL' },
  sorts: { number: 'number', scheduled: 'scheduled_at', status: 'status' },
  defaultSort: 'scheduled_at DESC',
};
interface JobRow { id: number; account_id: number | null; number: string | null; kind: string | null; status: string | null; scheduled_at: string | null; completed_at: string | null; }

router.get('/api/jobs', (req, res) => {
  const db = getDb();
  if (hasRealJobs()) {
    const result = runList<JobRow>(JOBS_SPEC, {
      q: req.query.q as string, filter: req.query.filter as string, sort: req.query.sort as string,
      order: req.query.order as string, page: req.query.page as string, pageSize: req.query.pageSize as string,
    });
    const nameOf = db.prepare(`SELECT name FROM accounts WHERE id = ?`);
    const jobs = result.rows.map((j) => {
      const a = j.account_id ? (nameOf.get(j.account_id) as { name: string } | undefined) : undefined;
      return {
        id: j.id, number: j.number || '—', kind: j.kind || '', status: j.status || '',
        account: a?.name || '—', accountId: j.account_id,
        scheduled: j.scheduled_at ? fmtDate(j.scheduled_at) : '—',
        completed: j.completed_at ? fmtDate(j.completed_at) : '',
      };
    });
    return res.json({
      jobs,
      counts: { all: countWith(JOBS_SPEC, 'all'), open: countWith(JOBS_SPEC, 'open'), completed: countWith(JOBS_SPEC, 'completed') },
      total: result.total, page: result.page, pageSize: result.pageSize, pages: result.pages, showing: jobs.length, live: true,
    });
  }
  res.json({ jobs: [], counts: { all: 0, open: 0, completed: 0 }, total: 0, page: 1, pages: 1, showing: 0, live: false });
});

// Quotes at scale.
const QUOTES_SPEC: ListSpec = {
  table: 'quotes',
  baseWhere: "source = 'servicetrade'",
  searchCols: ['number', 'title'],
  filters: { all: '1 = 1', valued: 'amount_cents > 0' },
  sorts: { amount: 'amount_cents', number: 'number' },
  defaultSort: 'amount_cents DESC',
};
interface QuoteListRow { id: number; account_id: number | null; number: string | null; title: string | null; amount_cents: number | null; stage: string | null; }

router.get('/api/quotes', (req, res) => {
  const db = getDb();
  if (hasRealQuotes()) {
    const result = runList<QuoteListRow>(QUOTES_SPEC, {
      q: req.query.q as string, filter: req.query.filter as string, sort: req.query.sort as string,
      order: req.query.order as string, page: req.query.page as string, pageSize: req.query.pageSize as string,
    });
    const nameOf = db.prepare(`SELECT name FROM accounts WHERE id = ?`);
    const quotes = result.rows.map((q) => {
      const a = q.account_id ? (nameOf.get(q.account_id) as { name: string } | undefined) : undefined;
      return {
        id: q.id, number: q.number || '—', title: q.title || '', amount: money(q.amount_cents || 0),
        status: q.stage || '', account: a?.name || '—', accountId: q.account_id,
      };
    });
    return res.json({
      quotes,
      counts: { all: countWith(QUOTES_SPEC, 'all'), valued: countWith(QUOTES_SPEC, 'valued') },
      total: result.total, page: result.page, pageSize: result.pageSize, pages: result.pages, showing: quotes.length, live: true,
    });
  }
  res.json({ quotes: [], counts: { all: 0, valued: 0 }, total: 0, page: 1, pages: 1, showing: 0, live: false });
});

// An account's real ServiceTrade invoices (read-only, live). Powers real balances on the
// account detail and lets us see WHY an account is overdue (invoice ages, paid vs open).
router.get('/api/accounts/:id/invoices', async (req, res) => {
  const db = getDb();
  const a = db.prepare(`SELECT st_id, name FROM accounts WHERE id = ?`).get(Number(req.params.id)) as { st_id: string | null; name: string } | undefined;
  if (!a) return res.status(404).json({ ok: false, error: 'not found' });
  if (!a.st_id || !stConfigured()) return res.json({ live: false, account: a.name, invoices: [], summary: {} });
  try {
    const resp = await stGet(`/invoice?customerId=${encodeURIComponent(a.st_id)}`);
    const body = (resp as any)?.data ?? resp ?? {};
    const nowSec = Math.floor(Date.now() / 1000);
    const invoices = ((body.invoices as any[]) || []).map((inv) => {
      const total = Number(inv.totalPrice) || 0;
      const paidAmt = Number(inv.totalPaidAmount) || 0;
      const open = Math.max(0, total - paidAmt);
      const overdue = inv.dueDate != null && Number(inv.dueDate) < nowSec && !inv.paid && open > 0;
      const ageDays = inv.dueDate != null ? Math.round((nowSec - Number(inv.dueDate)) / 86400) : null;
      return {
        number: inv.invoiceNumber, status: inv.status, substatus: inv.substatus, paid: !!inv.paid,
        total, paidAmount: paidAmt, open,
        dueDate: inv.dueDate ? new Date(inv.dueDate * 1000).toISOString().slice(0, 10) : null,
        transactionDate: inv.transactionDate ? new Date(inv.transactionDate * 1000).toISOString().slice(0, 10) : null,
        overdue, ageDays,
      };
    });
    const openInv = invoices.filter((i) => i.open > 0);
    const summary = {
      count: invoices.length,
      openCount: openInv.length,
      openTotal: openInv.reduce((s, i) => s + i.open, 0),
      overdueCount: invoices.filter((i) => i.overdue).length,
      oldestOverdueDays: Math.max(0, ...invoices.filter((i) => i.overdue).map((i) => i.ageDays || 0)),
    };
    res.json({ live: true, account: a.name, summary, invoices });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

router.get('/api/accounts/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const a = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as Acc | undefined;
  if (!a) return res.status(404).json({ ok: false, error: 'not found' });

  const sites = (db.prepare(`SELECT * FROM sites WHERE account_id = ? ORDER BY id`).all(id) as any[]).map((s) => {
    const eq = db.prepare(`SELECT kind, count FROM equipment WHERE site_id = ? ORDER BY id`).all(s.id) as Array<{ kind: string; count: number }>;
    return { ...s, equipment: eq, next_label: fmtDate(s.next_service_at) };
  });
  const contacts = db.prepare(`SELECT * FROM contacts WHERE account_id = ? ORDER BY is_primary DESC, id`).all(id);
  const events = db
    .prepare(
      `SELECT tag, title, body, source, meta,
              CAST((julianday('now') - julianday(occurred_at)) * 24 * 60 AS INTEGER) AS age_mins
         FROM account_events WHERE account_id = ? ORDER BY occurred_at DESC`
    )
    .all(id);

  const quotedNotWon = (
    db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS v FROM quotes WHERE account_id = ? AND stage IN ('quoted','following_up')`).get(id) as {
      v: number;
    }
  ).v;

  const stats = {
    lifetime: money(a.lifetime_cents),
    balance: money(a.balance_cents),
    avgDaysToPay: a.avg_days_to_pay ?? '—',
    openDeficiencies: 6,
    quotedNotWon: money(quotedNotWon),
    reviews: '4.9 ★',
  };

  res.json({
    account: {
      ...a,
      initials: initials(a.name),
      contract: CONTRACT(a.contract_type),
      renews: fmtDate(a.contract_renews_at),
      overdueDays: a.risk === 'at_risk' && a.balance_cents > 0 ? 98 : 0,
      meta: `${a.segment} · ${sites.length} site${sites.length === 1 ? '' : 's'} · customer since ${a.customer_since} · ServiceTrade ID ${(a.st_id || '').replace('ST-', '')} · owner ${a.owner_user}`,
    },
    sites,
    contacts,
    stats,
    events,
    live: false,
  });
});

// Pipeline — per-stage headline count/total are fixtures (matching the design); the deal
// cards are the seeded quotes.
const STAGES = [
  { key: 'lead', label: 'Lead', sq: 'var(--muted)', count: 6, total: 5400000 },
  { key: 'quoted', label: 'Quoted', sq: 'var(--indigo)', count: 14, total: 18600000 },
  { key: 'following_up', label: 'Following up', sq: 'var(--amber)', count: 9, total: 12100000 },
  { key: 'won', label: 'Won', sq: 'var(--green)', count: 7, total: 5100000 },
  { key: 'lost', label: 'Lost', sq: 'var(--border-strong)', count: 3, total: 2200000 },
];

function dealChip(q: any): { text: string; tone: string } {
  if (q.stage === 'lost') return { text: 'reason logged', tone: 'gray' };
  if (q.stage === 'won') return { text: 'synced', tone: 'green' };
  if (q.stage === 'following_up') return q.snooze_until ? { text: 'snoozed', tone: 'gray' } : { text: 'agent working', tone: 'indigo' };
  if (q.stage === 'quoted') {
    if (q.opened_count >= 3) return { text: `opened ${q.opened_count}×`, tone: 'indigo' };
    if (!q.opened_count) return { text: 'no reply', tone: 'money' };
    return { text: 'day 1', tone: 'gray' };
  }
  return q.origin === 'call' ? { text: 'from a call', tone: 'green' } : { text: q.origin || 'lead', tone: 'gray' };
}

// ServiceTrade quote statuses (draft/submitted/accepted/rejected/canceled…) → the board's five
// stages. This one mapping is what makes real quotes visible on the pipeline (and the Closer).
export function mapQuoteStage(status: string | null): string {
  const s = (status || '').toLowerCase();
  if (s === 'draft') return 'lead';
  if (s === 'submitted' || s === 'pending' || s === 'reviewed' || s === 'contingent') return 'quoted';
  if (s === 'accepted' || s === 'approved' || s === 'won') return 'won';
  if (s === 'rejected' || s === 'lost' || s === 'canceled' || s === 'cancelled' || s === 'expired' || s === 'void') return 'lost';
  return 'quoted';
}
function realChip(q: any, stageKey: string): { text: string; tone: string } {
  const s = (q.stage || '').toLowerCase();
  if (stageKey === 'won') return { text: 'accepted', tone: 'green' };
  if (stageKey === 'lost') return { text: s === 'rejected' ? 'rejected' : s === 'canceled' || s === 'cancelled' ? 'canceled' : s || 'lost', tone: 'gray' };
  if (s === 'draft') return { text: 'draft', tone: 'gray' };
  if (s === 'submitted') return { text: 'submitted', tone: 'indigo' };
  return { text: s || 'open', tone: 'gray' };
}

router.get('/api/pipeline', (_req, res) => {
  const db = getDb();
  const real = hasRealQuotes();
  const rows = db
    .prepare(
      real
        ? `SELECT q.*, a.name AS customer FROM quotes q LEFT JOIN accounts a ON a.id = q.account_id WHERE q.source = 'servicetrade' ORDER BY q.amount_cents DESC`
        : `SELECT q.*, a.name AS customer FROM quotes q LEFT JOIN accounts a ON a.id = q.account_id ORDER BY q.amount_cents DESC`
    )
    .all() as any[];
  const stageOf = (q: any): string => (real ? mapQuoteStage(q.stage) : q.stage);

  const stages = STAGES.map((s) => {
    const inStage = rows.filter((q) => stageOf(q) === s.key);
    // real boards can have hundreds per column — show the top 25 by value, count is the real total.
    const shown = real ? inStage.slice(0, 25) : inStage;
    const deals = shown.map((q) => {
      const chip = real ? realChip(q, s.key) : dealChip(q);
      return { id: q.id, customer: q.customer || 'Prospect', detail: q.title, amount: money(q.amount_cents), chip: chip.text, chipTone: chip.tone, lost: s.key === 'lost' };
    });
    const count = real ? inStage.length : s.count;
    const total = real ? inStage.reduce((a, q) => a + (q.amount_cents || 0), 0) : s.total;
    return { key: s.key, label: s.label, sq: s.sq, count, total: money(total), deals };
  });

  let stats;
  if (real) {
    const openCents = rows.filter((q) => ['lead', 'quoted', 'following_up'].includes(mapQuoteStage(q.stage))).reduce((a, q) => a + (q.amount_cents || 0), 0);
    const won = rows.filter((q) => mapQuoteStage(q.stage) === 'won').length;
    const lost = rows.filter((q) => mapQuoteStage(q.stage) === 'lost').length;
    stats = {
      open: money(openCents),
      aging: rows.filter((q) => mapQuoteStage(q.stage) === 'quoted').length,
      winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) + '%' : '—',
      fromDeficiencies: '—',
    };
  } else {
    stats = { open: '$412,300', aging: 11, winRate: '38%', fromDeficiencies: '$96,400' };
  }

  res.json({ stats, stages, live: real });
});

router.post('/api/pipeline/:quoteId/stage', (req, res) => {
  const db = getDb();
  const id = Number(req.params.quoteId);
  const stage = String(req.body?.stage || '');
  const valid = ['lead', 'quoted', 'following_up', 'won', 'lost'];
  if (!valid.includes(stage)) return res.status(400).json({ ok: false, error: 'invalid stage' });

  const q = db.prepare(`SELECT st_id FROM quotes WHERE id = ?`).get(id) as { st_id: string } | undefined;
  if (!q) return res.status(404).json({ ok: false, error: 'not found' });

  db.prepare(`UPDATE quotes SET stage = ?, sync_state = 'pending_push', local_updated_at = datetime('now') WHERE id = ?`).run(stage, id);
  // Queue the push — never write to ServiceTrade inline.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO sync_queue (object, local_id, st_id, op, payload, idempotency_key)
       VALUES ('quotes', ?, ?, 'update', ?, ?)`
    ).run(id, q.st_id || null, JSON.stringify({ stage }), `quote-${id}-stage-${stage}`);
    db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('out', ?, 'queued', 'quotes')`).run(
      `Quote stage → ${stage.replace('_', ' ')}`
    );
  } catch {
    /* queue is best-effort in the shell */
  }
  res.json({ ok: true, stage, live: false });
});

export default router;
