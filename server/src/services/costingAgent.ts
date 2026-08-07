import { getDb } from '../db/index';
import { TRADE_CONFIG } from '../config/tradeConfig';
import { createApproval } from '../routes/approvals';
import { COMPANY } from '../config/constants';
import { hasRealQuotes } from './servicetradeSync';

/**
 * The Job-Costing engine. The doctrine here is one line: MARGIN IS COMPUTED, NEVER STORED.
 * Every read recomputes quoted − (logged labour × rate + material + subs), so changing a cost
 * moves the number and no stale margin can lie to you. A bleeding job's out-of-scope overrun
 * becomes a drafted change order — GATED, because it quotes the customer a price.
 */

export interface JobCost {
  id: number;
  customer: string;
  work: string | null;
  quoted_cents: number | null;
  labor_hrs: number;
  labor_quoted_hrs: number;
  material_cents: number;
  sub_cents: number;
  sub_label: string | null;
  status: string;
  note: string | null;
}

export interface Margin {
  laborCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number; // rounded whole percent of quoted
}

/** The whole agent in one pure function: quoted − (labour + material + subs). Never persisted. */
export function jobMargin(j: JobCost): Margin {
  const laborCents = Math.round(j.labor_hrs * TRADE_CONFIG.costing.laborRate * 100);
  const costCents = laborCents + (j.material_cents || 0) + (j.sub_cents || 0);
  const quoted = j.quoted_cents || 0;
  const marginCents = quoted - costCents;
  const marginPct = quoted > 0 ? Math.round((marginCents / quoted) * 100) : 0;
  return { laborCents, costCents, marginCents, marginPct };
}

// margin band → colour: bleeding (<=0) money, thin (<target) amber, healthy green.
function marginFg(pct: number): string {
  if (pct <= 0) return 'var(--money)';
  if (pct < TRADE_CONFIG.costing.targetMarginPct) return 'var(--amber-ink)';
  return 'var(--green)';
}

const money = (cents: number) => (cents < 0 ? '-$' : '$') + Math.abs(Math.round(cents / 100)).toLocaleString('en-US');

/** Every job whose margin is at or below zero right now — the bleeders. */
export function flagBleeders(): (JobCost & { margin: Margin })[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM job_costs`).all() as JobCost[];
  return rows.map((j) => ({ ...j, margin: jobMargin(j) })).filter((j) => j.margin.marginPct <= 0);
}

/** Draft a change order for a job's out-of-scope overrun (GATED — it quotes a price). */
export function draftChangeOrder(jobId: number): { jobId: number; amount: string; body: string } {
  const db = getDb();
  const j = db.prepare(`SELECT * FROM job_costs WHERE id = ?`).get(jobId) as JobCost | undefined;
  if (!j) throw new Error(`job ${jobId} not found`);
  const m = jobMargin(j);

  // the change order recovers the labour overrun (logged − quoted hours) at the shop rate,
  // rounded up to the nearest $100 — the out-of-scope work you can bill.
  const overHrs = Math.max(0, j.labor_hrs - j.labor_quoted_hrs);
  const rawCents = Math.round(overHrs * TRADE_CONFIG.costing.laborRate * 100);
  const amountCents = Math.max(10000, Math.ceil(rawCents / 10000) * 10000);
  const amount = money(amountCents);
  const first = j.customer.split(/\s|—|-/)[0];
  const where = j.work || 'the site';
  const body = `Hi ${first} — the scope at ${where} ran past the quote: ${Math.round(overHrs)} extra crew hours went to work that wasn't in the original bid. I'd like to attach a change order for ${amount} to cover it — happy to walk the site with you first. — ${COMPANY.name}`;

  createApproval({
    agent_key: 'costing',
    kind: 'quote_price',
    risk: 'sensitive',
    title: `Change order · ${j.customer}`,
    stake: amount,
    body,
    trail: `Recovers ${Math.round(overHrs)} out-of-scope hours; goes to the customer for a yes`,
    subject_type: 'job',
    subject_id: jobId,
  });
  return { jobId, amount, body };
}

// ── Live "Job value" view (revenue side). True margins need cost data (Sage Intacct), which
//    ServiceTrade does not expose — so this shows booked/open job revenue honestly, office-scoped,
//    and flags that margins arrive when Sage connects. ──
const ST_APP = 'https://app.servicetrade.com';
const WON = ['accepted', 'approved', 'won'];
const OPEN = ['submitted', 'pending', 'reviewed', 'contingent', 'draft'];
const sqlIn = (arr: string[]) => arr.map((s) => `'${s}'`).join(',');
const officeShort = (o: string) => (o || '').replace(/^Northstar\s*/i, '').replace(/\s*LLC$/i, '').trim() || '—';

function realJobValue(office = '') {
  const db = getDb();
  const oc = office ? ' AND q.office = @office' : '';
  const bind: any = office ? { office } : {};
  const scalar = (sql: string) => (db.prepare(sql).get(...(office ? [bind] : [])) as { v: number }).v || 0;

  const bookedCents = scalar(`SELECT COALESCE(SUM(amount_cents),0) AS v FROM quotes q WHERE q.source='servicetrade' AND lower(q.stage) IN (${sqlIn(WON)})${oc}`);
  const wonCount = scalar(`SELECT COUNT(*) AS v FROM quotes q WHERE q.source='servicetrade' AND lower(q.stage) IN (${sqlIn(WON)})${oc}`);
  const openCents = scalar(`SELECT COALESCE(SUM(amount_cents),0) AS v FROM quotes q WHERE q.source='servicetrade' AND lower(q.stage) IN (${sqlIn(OPEN)})${oc}`);
  const avg = wonCount ? Math.round(bookedCents / wonCount) : 0;

  const stmt = db.prepare(
    `SELECT q.id, q.st_id, q.number, q.title, q.amount_cents, q.stage, q.office, a.name AS customer
       FROM quotes q LEFT JOIN accounts a ON a.id = q.account_id
      WHERE q.source='servicetrade' AND lower(q.stage) IN (${sqlIn(WON.concat(OPEN))})${oc}
      ORDER BY q.amount_cents DESC LIMIT 120`
  );
  const rows = (office ? stmt.all(bind) : stmt.all()) as { id: number; st_id: string | null; number: string | null; title: string | null; amount_cents: number | null; stage: string | null; office: string | null; customer: string | null }[];

  const jobs = rows.map((q) => {
    const won = WON.includes((q.stage || '').toLowerCase());
    return {
      id: q.id,
      customer: q.customer || 'Prospect',
      work: q.title || '',
      value: money(q.amount_cents || 0),
      office: officeShort(q.office || ''),
      status: won ? 'won' : 'open',
      statusTone: won ? 'var(--green)' : 'var(--muted)',
      stUrl: q.st_id ? `${ST_APP}/quotes/${q.st_id}` : null,
    };
  });

  return {
    summary: {
      kpis: [
        { lab: 'Booked revenue', val: money(bookedCents), sub: `${wonCount.toLocaleString()} jobs won`, color: 'var(--green)' },
        { lab: 'Average job value', val: money(avg), sub: 'per won job', color: 'var(--ink)' },
        { lab: 'Open value', val: money(openCents), sub: 'quoted, not yet booked', color: 'var(--ink)' },
        { lab: 'Margins', val: 'Pending', sub: 'unlock when Sage connects', color: 'var(--money)' },
      ],
      banner: 'This is the revenue side of every job — real, from ServiceTrade. True margins need job costs (labor, parts), which live in Sage Intacct and are not yet connected. When Sage is in, cost lands beside each number here and this becomes real margins.',
    },
    jobs,
    focus: null,
    changeOrder: null,
    live: true,
  };
}

export function getCostingSummary(office = '') {
  if (hasRealQuotes()) return realJobValue(office);
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM job_costs`).all() as JobCost[];
  const withM = rows.map((j) => ({ j, m: jobMargin(j) }));

  // every job, worst margin first (the table).
  const sorted = withM.slice().sort((a, b) => a.m.marginPct - b.m.marginPct);
  const jobs = sorted.map(({ j, m }) => {
    const bleeding = m.marginPct <= 0;
    return {
      id: j.id,
      customer: j.customer,
      work: j.work || '',
      quoted: money(j.quoted_cents || 0),
      cost: money(m.costCents),
      pct: `${m.marginPct}%`,
      mFg: marginFg(m.marginPct),
      bar: `${bleeding ? 6 : Math.max(4, Math.min(100, m.marginPct))}%`,
      note: j.note || '',
      status: j.status,
      cta: bleeding ? 'Draft change order' : 'View',
      ctaDark: bleeding,
    };
  });

  // the focus job in the right rail: the flagged Northside warehouse (the design's anchor),
  // else the worst in-progress bleeder.
  const focusRow =
    withM.find((x) => /warehouse\s*4/i.test(x.j.work || '') || /warehouse\s*4/i.test(x.j.customer)) ||
    sorted.find((x) => x.j.status === 'in_progress' && x.m.marginPct <= 0);
  let focus = null;
  let changeOrder = null;
  if (focusRow) {
    const { j, m } = focusRow;
    focus = {
      jobId: j.id,
      title: j.work ? `${j.customer} — ${j.work}` : j.customer,
      pct: `${m.marginPct}%`,
      pctFg: marginFg(m.marginPct),
      quoted: money(j.quoted_cents || 0),
      laborHrs: Math.round(j.labor_hrs),
      laborQuotedHrs: Math.round(j.labor_quoted_hrs),
      labor: money(m.laborCents),
      laborOver: j.labor_hrs > j.labor_quoted_hrs,
      material: money(j.material_cents || 0),
      sub: money(j.sub_cents || 0),
      subLabel: j.sub_label || 'Sub',
      margin: money(m.marginCents),
      marginFg: marginFg(m.marginPct),
      insight: j.note || 'Out-of-scope work you can bill.',
    };
    if (m.marginPct <= 0) {
      const overHrs = Math.max(0, j.labor_hrs - j.labor_quoted_hrs);
      const amountCents = Math.max(10000, Math.ceil(Math.round(overHrs * TRADE_CONFIG.costing.laborRate * 100) / 10000) * 10000);
      changeOrder = {
        jobId: j.id,
        amount: money(amountCents),
        body: `"The panel enclosures at ${j.work || 'the site'} were sealed behind work that wasn't in the original scope — ${Math.round(overHrs)} extra crew hours went to clearing and re-securing them. Attaching a change order for ${money(amountCents)}; happy to walk the site with you first." — ${COMPANY.name}`,
      };
    }
  }

  return {
    // portfolio headline KPIs are shell fixtures matching the design; per-job margins are real.
    summary: {
      portfolioMargin: '34.2%',
      target: '32%',
      jobsClosed: 41,
      losingCount: 5,
      atRisk: '$18,900',
      bestPct: '61%',
      bestJob: 'Bulverde extinguishers',
      bleedsFrom: 'Labor',
      bleedShare: '68% of every overrun',
    },
    jobs,
    focus,
    changeOrder,
    live: false,
  };
}
