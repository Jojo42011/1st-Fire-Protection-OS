import { getDb } from '../db/index';
import { stGet, stConfigured } from './servicetrade';
import { canonicalOffice, officeLabel } from '../os/office';

/**
 * The repair funnel, live from ServiceTrade: deficiencies found -> quotes sent -> quotes approved ->
 * repairs invoiced, plus how fast a deficiency becomes a sent quote and how many customers we serve.
 * Read-only (GETs only). The math is a pure function over the fetched rows so it is testable.
 *
 * Definitions (ServiceTrade has no single "funnel" report, so these are stated plainly):
 *  - Deficiency found: reportedOn (else created) in the period. Deficiencies carry no price, so the
 *    $ value is the total of the quotes linked to them (a quote's deficiencyJobs), each quote once.
 *  - Quote sent: latestSubmission in the period (a re-sent quote counts on its latest send).
 *  - Quote approved: a quote sent in the period whose status is now accepted/approved/won.
 *  - Repair invoiced: an invoice dated (transactionDate) in the period on a repair-type job.
 *  - Days to quote: from a deficiency's date to the first sent quote linked to its job, on or after it.
 *  - Office: the job's assigned office (the deficiency's job, the quote's linked job, the invoice's job).
 */

export interface StDef { id: number; status?: string; reportedOn?: number | null; created?: number | null; job?: { id?: number } | null }
export interface StQuoteRow { id: number; status?: string; totalPrice?: string | number; latestSubmission?: number | null; created?: number | null; deficiencyJobs?: any[]; assignedOffice?: { name?: string } | null; customer?: { id?: number } | null }
export interface StInvoiceRow { id: number; totalPrice?: string | number; transactionDate?: number | null; job?: { id?: number; type?: string } | null; status?: string }
export interface StJobRow { id: number; type?: string; completedOn?: number | null; customer?: { id?: number } | null; assignedOffice?: { name?: string } | null }

export interface FunnelData { deficiencies: StDef[]; quotes: StQuoteRow[]; invoices: StInvoiceRow[]; jobs: StJobRow[] }
export interface Period { label: string; from: string; to: string } // YYYY-MM-DD, inclusive

export interface FunnelNumbers {
  deficiencies: { count: number; quoted: number; quotedUsd: number };
  quotesSent: { count: number; usd: number };
  quotesApproved: { count: number; usd: number };
  repairsInvoiced: { count: number; usd: number };
  daysToQuote: { avg: number | null; median: number | null; pairs: number };
}

const WON = new Set(['accepted', 'approved', 'won']);
/** ServiceTrade job types that are repair work (not inspections / maintenance). */
export const REPAIR_TYPE = /repair|replace|emergency|service_call|deficien|upgrade/i;

const money = (v: unknown) => { const n = Number(String(v ?? 0).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const jobIdOf = (j: any): number | null => { const v = j && typeof j === 'object' ? j.id : j; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const dayOf = (unix: number | null | undefined): string | null => (unix && unix > 0 ? new Date(unix * 1000).toISOString().slice(0, 10) : null);
const inP = (d: string | null, p: Period) => !!d && d >= p.from && d <= p.to;

/** Compute the funnel for one period, optionally for one office key. Pure. */
export function computeFunnel(data: FunnelData, p: Period, office: string | null = null): FunnelNumbers {
  const jobOffice = new Map<number, string>();
  const jobType = new Map<number, string>();
  for (const j of data.jobs) {
    if (j.assignedOffice?.name) jobOffice.set(j.id, canonicalOffice(j.assignedOffice.name));
    if (j.type) jobType.set(j.id, j.type);
  }
  const officeOfJob = (jid: number | null) => (jid != null ? jobOffice.get(jid) || null : null);
  const quoteJobs = (q: StQuoteRow) => (q.deficiencyJobs || []).map(jobIdOf).filter((x): x is number => x != null);
  const quoteOffice = (q: StQuoteRow) => {
    for (const jid of quoteJobs(q)) { const o = officeOfJob(jid); if (o) return o; }
    return q.assignedOffice?.name ? canonicalOffice(q.assignedOffice.name) : null;
  };
  const keep = (o: string | null) => office == null || o === office;

  // quotes by linked job, for deficiency $ and days-to-quote
  const quotesByJob = new Map<number, StQuoteRow[]>();
  for (const q of data.quotes) for (const jid of quoteJobs(q)) { if (!quotesByJob.has(jid)) quotesByJob.set(jid, []); quotesByJob.get(jid)!.push(q); }

  // 1. deficiencies found
  const defs = data.deficiencies.filter((d) => inP(dayOf(d.reportedOn ?? d.created ?? null), p) && keep(officeOfJob(jobIdOf(d.job))));
  const linkedQuotes = new Map<number, number>();
  let quoted = 0;
  const gaps: number[] = [];
  for (const d of defs) {
    const jid = jobIdOf(d.job);
    const qs = jid != null ? quotesByJob.get(jid) || [] : [];
    if (qs.length) quoted++;
    for (const q of qs) linkedQuotes.set(q.id, money(q.totalPrice));
    const found = Number(d.reportedOn ?? d.created ?? 0);
    const sends = qs.map((q) => Number(q.latestSubmission || 0)).filter((s) => s > 0 && s >= found);
    if (found > 0 && sends.length) gaps.push((Math.min(...sends) - found) / 86400);
  }

  // 2-3. quotes sent / approved
  const sent = data.quotes.filter((q) => inP(dayOf(q.latestSubmission ?? null), p) && keep(quoteOffice(q)));
  const won = sent.filter((q) => WON.has(String(q.status || '').toLowerCase()));

  // 4. repairs invoiced
  const repairs = data.invoices.filter((inv) => {
    if (!inP(dayOf(inv.transactionDate ?? null), p)) return false;
    const jid = jobIdOf(inv.job);
    const type = inv.job?.type || (jid != null ? jobType.get(jid) : undefined) || '';
    return REPAIR_TYPE.test(type) && keep(officeOfJob(jid));
  });

  gaps.sort((a, b) => a - b);
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  return {
    deficiencies: { count: defs.length, quoted, quotedUsd: sum([...linkedQuotes.values()]) },
    quotesSent: { count: sent.length, usd: sum(sent.map((q) => money(q.totalPrice))) },
    quotesApproved: { count: won.length, usd: sum(won.map((q) => money(q.totalPrice))) },
    repairsInvoiced: { count: repairs.length, usd: sum(repairs.map((i) => money(i.totalPrice))) },
    daysToQuote: {
      avg: gaps.length ? Math.round((sum(gaps) / gaps.length) * 10) / 10 : null,
      median: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)] * 10) / 10 : null,
      pairs: gaps.length,
    },
  };
}

/** Customers with a completed job in the last 12 months, plus the mirrored account and location counts. */
export function customerCounts(data: FunnelData, now = new Date()): { accounts: number; locations: number; activeAccounts: number } {
  const db = getDb();
  const one = (sql: string) => Number((db.prepare(sql).get() as any)?.c || 0);
  const since = Math.floor(now.getTime() / 1000) - 365 * 86400;
  const active = new Set<number>();
  for (const j of data.jobs) if (Number(j.completedOn || 0) >= since && j.customer?.id) active.add(Number(j.customer.id));
  return {
    accounts: one(`SELECT COUNT(*) c FROM accounts WHERE source = 'servicetrade'`),
    locations: one(`SELECT COUNT(*) c FROM sites WHERE source = 'servicetrade'`),
    activeAccounts: active.size,
  };
}

async function pageAll<T>(path: string, key: string, cap = 400): Promise<T[]> {
  const out: T[] = [];
  let page = 1, total = 1;
  while (page <= total && page <= cap) {
    const sep = path.includes('?') ? '&' : '?';
    // eslint-disable-next-line no-await-in-loop
    const resp: any = await stGet(`${path}${sep}limit=1000&page=${page}`);
    const body = resp?.data ?? resp ?? {};
    const rows: T[] = body[key] || (Array.isArray(body) ? body : []);
    total = Number(body.totalPages) || 1;
    out.push(...rows);
    if (!rows.length) break;
    page++;
  }
  return out;
}

/** Everything the funnel needs, from `since` (unix seconds) on, live from ServiceTrade. */
export async function fetchFunnelData(since: number): Promise<FunnelData> {
  if (!stConfigured()) throw new Error('ServiceTrade is not connected');
  const [deficiencies, quotes, invoices, jobs] = [
    await pageAll<StDef>('/deficiency', 'deficiencies'),
    await pageAll<StQuoteRow>('/quote', 'quotes'),
    await pageAll<StInvoiceRow>('/invoice', 'invoices'),
    await pageAll<StJobRow>(`/job?status=*&longForm=true&completedOnBegin=${since}`, 'jobs'),
  ];
  return { deficiencies, quotes, invoices, jobs };
}

export interface FunnelReport {
  generatedAt: string;
  periods: { period: Period; total: FunnelNumbers }[];
  byOffice: { period: Period; rows: { office: string; label: string; n: FunnelNumbers }[] };
  customers: { accounts: number; locations: number; activeAccounts: number };
  repairJobTypes: Record<string, number>;
  fetched: { deficiencies: number; quotes: number; invoices: number; jobs: number };
}

export function buildReport(data: FunnelData, now = new Date()): FunnelReport {
  const today = now.toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const ttmFrom = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);
  const periods: Period[] = [
    { label: `${year - 1}`, from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
    { label: `${year} to date`, from: `${year}-01-01`, to: today },
    { label: 'Last 12 months', from: ttmFrom, to: today },
  ];
  const ttm = periods[2];
  const offices = new Set<string>();
  for (const j of data.jobs) if (j.assignedOffice?.name) { const k = canonicalOffice(j.assignedOffice.name); if (k) offices.add(k); }
  const rows = [...offices].map((o) => ({ office: o, label: officeLabel(o) || o, n: computeFunnel(data, ttm, o) }))
    .filter((r) => r.n.deficiencies.count || r.n.quotesSent.count || r.n.repairsInvoiced.count)
    .sort((a, b) => b.n.repairsInvoiced.usd - a.n.repairsInvoiced.usd);
  const repairJobTypes: Record<string, number> = {};
  for (const j of data.jobs) if (j.type && REPAIR_TYPE.test(j.type)) repairJobTypes[j.type] = (repairJobTypes[j.type] || 0) + 1;
  return {
    generatedAt: now.toISOString(),
    periods: periods.map((p) => ({ period: p, total: computeFunnel(data, p) })),
    byOffice: { period: ttm, rows },
    customers: customerCounts(data, now),
    repairJobTypes,
    fetched: { deficiencies: data.deficiencies.length, quotes: data.quotes.length, invoices: data.invoices.length, jobs: data.jobs.length },
  };
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function reportHtml(r: FunnelReport): string {
  const th = (s: string) => `<th style="text-align:right;padding:6px 10px;border-bottom:1px solid #D0D5DD;font-size:12px;color:#475467">${esc(s)}</th>`;
  const td = (s: string, left = false) => `<td style="text-align:${left ? 'left' : 'right'};padding:6px 10px;border-bottom:1px solid #EAECF0">${s}</td>`;
  const line = (label: string, f: (n: FunnelNumbers) => string) => `<tr>${td(`<b>${esc(label)}</b>`, true)}${r.periods.map((p) => td(f(p.total))).join('')}</tr>`;
  const days = (n: FunnelNumbers) => (n.daysToQuote.avg == null ? 'n/a' : `${n.daysToQuote.avg} days <span style="color:#667085">(median ${n.daysToQuote.median})</span>`);
  const main = `<table style="border-collapse:collapse;font-size:14px;width:100%"><thead><tr><th></th>${r.periods.map((p) => th(p.period.label)).join('')}</tr></thead><tbody>
    ${line('1. Deficiencies found', (n) => n.deficiencies.count.toLocaleString())}
    ${line('   $ quoted against them', (n) => `${usd(n.deficiencies.quotedUsd)} <span style="color:#667085">(${n.deficiencies.quoted.toLocaleString()} quoted)</span>`)}
    ${line('2. Quotes sent', (n) => `${n.quotesSent.count.toLocaleString()} / ${usd(n.quotesSent.usd)}`)}
    ${line('3. Quotes approved', (n) => `${n.quotesApproved.count.toLocaleString()} / ${usd(n.quotesApproved.usd)}`)}
    ${line('4. Repairs invoiced', (n) => `${usd(n.repairsInvoiced.usd)} <span style="color:#667085">(${n.repairsInvoiced.count.toLocaleString()})</span>`)}
    ${line('5. Deficiency found to quote sent', days)}
  </tbody></table>`;
  const offices = r.byOffice.rows.length ? `<h3 style="font-size:15px;margin:22px 0 6px">By office, ${esc(r.byOffice.period.label.toLowerCase())}</h3>
    <table style="border-collapse:collapse;font-size:13px;width:100%"><thead><tr><th></th>${['Deficiencies', 'Quotes sent', 'Approved', 'Repairs invoiced', 'Days to quote'].map(th).join('')}</tr></thead><tbody>
    ${r.byOffice.rows.map((o) => `<tr>${td(`<b>${esc(o.label)}</b>`, true)}${td(o.n.deficiencies.count.toLocaleString())}${td(`${o.n.quotesSent.count} / ${usd(o.n.quotesSent.usd)}`)}${td(`${o.n.quotesApproved.count} / ${usd(o.n.quotesApproved.usd)}`)}${td(usd(o.n.repairsInvoiced.usd))}${td(o.n.daysToQuote.avg == null ? 'n/a' : String(o.n.daysToQuote.avg))}</tr>`).join('')}
    </tbody></table>` : '';
  const c = r.customers;
  const types = Object.entries(r.repairJobTypes).map(([k, v]) => `${k} (${v})`).join(', ') || 'none found';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#101828;max-width:760px">
    <h2 style="font-size:18px;margin:0 0 4px">ServiceTrade repair funnel</h2>
    <p style="color:#667085;margin:0 0 14px;font-size:13px">Live from ServiceTrade, ${esc(r.generatedAt.slice(0, 10))}.</p>
    ${main}
    <h3 style="font-size:15px;margin:22px 0 6px">6. Customers</h3>
    <p style="margin:0;font-size:14px"><b>${c.activeAccounts.toLocaleString()}</b> customers with a completed job in the last 12 months. ServiceTrade holds ${c.accounts.toLocaleString()} customer accounts and ${c.locations.toLocaleString()} service locations in total.</p>
    ${offices}
    <h3 style="font-size:14px;margin:22px 0 6px;color:#475467">How these are counted</h3>
    <ul style="font-size:12px;color:#475467;line-height:1.5;padding-left:18px;margin:0">
      <li>Deficiencies carry no price in ServiceTrade, so their $ is the total of the quotes linked to them (each quote once).</li>
      <li>Quotes sent uses each quote's latest send date. Approved means a quote sent in that period that is now accepted.</li>
      <li>Repairs invoiced are invoices dated in the period on repair-type jobs: ${esc(types)}.</li>
      <li>Days to quote runs from the deficiency date to the first sent quote linked to the same job.</li>
      <li>Read ${r.fetched.deficiencies.toLocaleString()} deficiencies, ${r.fetched.quotes.toLocaleString()} quotes, ${r.fetched.invoices.toLocaleString()} invoices and ${r.fetched.jobs.toLocaleString()} completed jobs.</li>
    </ul></div>`;
}

/** Fetch, compute and render. Jobs are read from the start of last year so every period has office data. */
export async function runFunnelReport(now = new Date()): Promise<FunnelReport> {
  const since = Math.floor(Date.UTC(now.getUTCFullYear() - 1, 0, 1) / 1000) - 120 * 86400;
  return buildReport(await fetchFunnelData(since), now);
}
