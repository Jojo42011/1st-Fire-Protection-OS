import { getDb } from '../db/index';
import { TRADE_CONFIG } from '../config/tradeConfig';
import { createApproval } from '../routes/approvals';
import { COMPANY } from '../config/constants';

/**
 * The Closer engine. Chases every open quote on a cadence (day 1 nudge, day 3 value, day 7
 * last call, then stalled) — cadence is engine logic from TRADE_CONFIG, not a prompt. Drafts
 * are GATED. Every lost quote's reason is logged so the "why we lose" panel can graduate into
 * the shared context library.
 */

export interface QuoteRow {
  id: number;
  account_id: number | null;
  number: string | null;
  title: string | null;
  amount_cents: number | null;
  stage: string;
  sent_at: string | null;
}

const daysSince = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = new Date(iso.length <= 10 ? iso + 'T00:00:00Z' : iso).getTime();
  if (!isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
};

/** Which follow-up tier a quote is in, from days-since-sent + how many touches it's had. */
export function tierFor(days: number | null, priorTouches = 0): string {
  if (days == null) return 'awaiting_price';
  const { cadence, stalledAfterDays } = TRADE_CONFIG.closer;
  if (days >= stalledAfterDays) return 'stalled';
  // walk the cadence from the top down
  for (let i = cadence.length - 1; i >= 0; i--) {
    if (days >= cadence[i].dayFrom) {
      // a last-call quote that's already been chased a few times is stalled
      if (cadence[i].tier === 'last_call' && priorTouches >= 3) return 'stalled';
      return cadence[i].tier;
    }
  }
  return 'queued';
}

const TIER_META: Record<string, { label: string; pill: string; channel: string }> = {
  awaiting_price: { label: 'awaiting price', pill: 'amber', channel: 'email' },
  queued: { label: 'queued', pill: 'indigo', channel: 'email' },
  nudge: { label: 'nudge sent', pill: 'green', channel: 'email' },
  value: { label: 'value sent', pill: 'green', channel: 'email' },
  last_call: { label: 'last call', pill: 'money', channel: 'email' },
  stalled: { label: 'stalled', pill: 'gray', channel: 'email' },
};

const NEXT_MOVE: Record<string, { next: string; cta: string }> = {
  awaiting_price: { next: 'Quote needs your approval', cta: 'Approve quote' },
  queued: { next: 'First nudge due', cta: 'Send nudge' },
  nudge: { next: 'Value email due next', cta: 'Send value' },
  value: { next: 'Last call if it stays quiet', cta: 'Send early' },
  last_call: { next: 'Last-call draft is waiting on you', cta: 'Review draft' },
  stalled: { next: 'Stalled — you decide', cta: 'Mark outcome' },
};

function touchCount(quoteId: number): number {
  return (getDb().prepare(`SELECT COUNT(*) AS v FROM closer_touches WHERE quote_id = ?`).get(quoteId) as { v: number }).v;
}

const money = (cents: number | null) => '$' + Math.round((cents || 0) / 100).toLocaleString('en-US');

/** Deterministic per-tier draft — the template fallback so keyless boot works. */
function templateFollowup(tier: string, customer: string, work: string, value: string): string {
  const firstName = customer.split(/\s|—/)[0];
  if (tier === 'last_call')
    return `${firstName} — last note from me on the ${work.toLowerCase()} quote (${value}). If it's a no for this budget cycle just say so and I'll close the file; otherwise I'd like to get it scheduled before it ages out. — ${COMPANY.name}`;
  if (tier === 'value')
    return `Hi ${firstName} — following up on the ${work.toLowerCase()} quote. Two things worth flagging: it's ${value} at today's rate card, and getting it on the schedule now avoids the next inspection cycle writing it up. Happy to walk the line items. — ${COMPANY.name}`;
  return `Hi ${firstName} — just making sure the ${work.toLowerCase()} quote (${value}) landed. Any questions on the scope or the number? Glad to adjust. — ${COMPANY.name}`;
}

export interface Followup {
  quoteId: number;
  tier: string;
  channel: string;
  body: string;
  value: string;
}

/** Draft the next-tier follow-up for a quote and GATE it (quote value on the line). */
export function draftFollowup(quoteId: number): Followup {
  const db = getDb();
  const q = db.prepare(`SELECT * FROM quotes WHERE id = ?`).get(quoteId) as QuoteRow | undefined;
  if (!q) throw new Error(`quote ${quoteId} not found`);
  const acc = q.account_id ? (db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(q.account_id) as { name: string } | undefined) : undefined;
  const customer = acc?.name || q.title || 'the customer';
  const work = q.title || 'the quoted work';
  const value = money(q.amount_cents);

  const tier = tierFor(daysSince(q.sent_at), touchCount(quoteId));
  const draftTier = tier === 'awaiting_price' || tier === 'queued' ? 'nudge' : tier === 'stalled' ? 'last_call' : tier;
  const meta = TIER_META[draftTier] || TIER_META.nudge;
  const body = templateFollowup(draftTier, customer, work, value);

  db.prepare(`INSERT INTO closer_touches (quote_id, channel, tier, body, status) VALUES (?, ?, ?, ?, 'draft')`).run(quoteId, meta.channel, draftTier, body);

  createApproval({
    agent_key: 'closer',
    kind: meta.channel === 'sms' ? 'send_sms' : 'send_email',
    risk: draftTier === 'last_call' ? 'sensitive' : 'routine',
    title: `${draftTier === 'last_call' ? 'Last-call' : draftTier === 'value' ? 'Value' : 'Nudge'} follow-up · ${customer}`,
    stake: `${value} on the line`,
    body,
    trail: draftTier === 'last_call' ? 'Final follow-up before the quote is marked stalled' : 'Goes to the contact on the quote',
    subject_type: 'quote',
    subject_id: quoteId,
  });

  return { quoteId, tier: draftTier, channel: meta.channel, body, value };
}

/** Record how an open quote resolved. 'lost' logs the reason for the context library. */
export function markOutcome(quoteId: number, outcome: 'won' | 'lost', reason?: string, detail?: string): { ok: true } {
  const db = getDb();
  db.prepare(`UPDATE quotes SET stage = ?, local_updated_at = datetime('now') WHERE id = ?`).run(outcome, quoteId);
  if (outcome === 'lost') {
    db.prepare(
      `INSERT INTO lost_reasons (quote_id, reason, detail) VALUES (?, ?, ?)
       ON CONFLICT(quote_id) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, logged_at = datetime('now')`
    ).run(quoteId, reason || 'none', detail || null);
  }
  return { ok: true };
}

// "why we lose" ordering + colours (the context that graduates into the shared library)
const REASONS: { key: string; label: string; tone: string }[] = [
  { key: 'price', label: 'Price', tone: 'var(--money)' },
  { key: 'incumbent', label: 'Went with incumbent', tone: 'var(--amber)' },
  { key: 'budget_cycle', label: 'Budget cycle', tone: 'var(--amber)' },
  { key: 'too_slow', label: 'Too slow to quote', tone: 'var(--muted)' },
  { key: 'none', label: 'No reason given', tone: 'var(--muted)' },
];

// Raw ServiceTrade quote statuses, bucketed the same way crm.ts mapQuoteStage does.
// Pulled quotes store the RAW status in quotes.stage (not the seed vocabulary), so the
// Closer has to read them through the same lens the pipeline board does.
// NOTE: 'draft' is deliberately EXCLUDED — a draft has never been sent, so there is nothing to
// follow up on. Drafts are the Estimator's worklist (Estimates tab); the Closer only chases
// quotes that have actually gone out to the customer and are awaiting a decision. Clean handoff.
const ST_OPEN = ['submitted', 'pending', 'reviewed', 'contingent'];
const ST_APP = 'https://app.servicetrade.com';
const ST_WON = ['accepted', 'approved', 'won'];
const ST_LOST = ['rejected', 'lost', 'canceled', 'cancelled', 'expired', 'void'];
const sqlList = (arr: string[]) => arr.map((s) => `'${s}'`).join(',');

/** Shape one open quote into the row the Closer screen renders (tier, next move, cta). */
function shapeQuoteRow(q: QuoteRow & { customer: string | null; st_id?: string | null }) {
  const days = daysSince(q.sent_at);
  const touches = touchCount(q.id);
  const tier = tierFor(days, touches);
  const meta = TIER_META[tier];
  const nm = NEXT_MOVE[tier];
  return {
    id: q.id,
    customer: q.customer || q.title || 'Prospect',
    work: q.title || '',
    value: money(q.amount_cents),
    age: days == null ? 'not sent' : `day ${days}`,
    ageTone: tier === 'last_call' || tier === 'stalled' ? 'var(--money)' : 'var(--muted)',
    tier: meta.label,
    tierPill: meta.pill,
    touches,
    next: nm.next,
    cta: nm.cta,
    ctaDark: tier === 'last_call',
    stUrl: q.st_id ? `${ST_APP}/quotes/${q.st_id}` : null,
  };
}

/** Real Closer summary computed off pulled ServiceTrade quotes. Optionally scoped to one office. */
function realPipelineSummary(office = '') {
  const db = getDb();
  const oc = office ? ' AND office = @office' : '';
  // better-sqlite3 rejects an explicit `undefined` bind, so pass args only when scoping.
  const scalar = (sql: string) => (db.prepare(sql).get(...(office ? [{ office }] : [])) as { v: number }).v || 0;

  // headline win rate is real: decided = won + lost across all pulled quotes (in scope)
  const won = scalar(`SELECT COUNT(*) AS v FROM quotes WHERE source = 'servicetrade' AND lower(stage) IN (${sqlList(ST_WON)})${oc}`);
  const lost = scalar(`SELECT COUNT(*) AS v FROM quotes WHERE source = 'servicetrade' AND lower(stage) IN (${sqlList(ST_LOST)})${oc}`);
  const decided = won + lost;
  const winRate = decided > 0 ? Math.round((won / decided) * 100) + '%' : '—';

  // open aggregates over the open book (in scope)
  const openCount = scalar(`SELECT COUNT(*) AS v FROM quotes WHERE source = 'servicetrade' AND lower(stage) IN (${sqlList(ST_OPEN)})${oc}`);
  const valueInPlay = scalar(`SELECT COALESCE(SUM(amount_cents), 0) AS v FROM quotes WHERE source = 'servicetrade' AND lower(stage) IN (${sqlList(ST_OPEN)})${oc}`);

  // the open book itself, oldest-sent first (nulls last), capped so the screen stays snappy
  const stmt = db.prepare(
    `SELECT q.id, q.st_id, q.account_id, q.number, q.title, q.amount_cents, q.stage, q.sent_at, a.name AS customer
       FROM quotes q LEFT JOIN accounts a ON a.id = q.account_id
      WHERE q.source = 'servicetrade' AND lower(q.stage) IN (${sqlList(ST_OPEN)})${office ? ' AND q.office = @office' : ''}
      ORDER BY (q.sent_at IS NULL), q.sent_at ASC
      LIMIT 80`
  );
  const rows = (office ? stmt.all({ office }) : stmt.all()) as (QuoteRow & { customer: string | null; st_id: string | null })[];

  const { stalledAfterDays } = TRADE_CONFIG.closer;
  let stalled = 0;
  let agedSum = 0;
  let agedN = 0;
  for (const q of rows) {
    const d = daysSince(q.sent_at);
    if (d != null) {
      agedSum += d;
      agedN++;
      if (d >= stalledAfterDays) stalled++;
    }
  }
  const avgDays = agedN > 0 ? String(Math.round(agedSum / agedN)) : '—';

  const quotes = rows.map(shapeQuoteRow);
  const needsGrp = new Set(['awaiting price', 'last call', 'stalled']);
  const needsTouch = quotes.filter((q) => needsGrp.has(q.tier)).length;

  // active draft: the highest-value quote already in last-call/stalled tier
  const urgent = rows
    .filter((q) => {
      const t = tierFor(daysSince(q.sent_at), touchCount(q.id));
      return t === 'last_call' || t === 'stalled';
    })
    .sort((a, b) => (b.amount_cents || 0) - (a.amount_cents || 0))[0];
  let activeDraft = null;
  if (urgent) {
    const value = money(urgent.amount_cents);
    const customer = urgent.customer || urgent.title || 'the customer';
    activeDraft = {
      quoteId: urgent.id,
      title: `${customer} — ${urgent.title || 'quoted work'}`,
      value: `${value} on the line`,
      tier: 'last call',
      body: templateFollowup('last_call', customer, urgent.title || 'the quoted work', value),
    };
  }

  // why we lose — real counts from lost_reasons (empty until outcomes get logged: honest zeros)
  const counts: Record<string, number> = {};
  (db.prepare(`SELECT reason, COUNT(*) AS c FROM lost_reasons GROUP BY reason`).all() as { reason: string; c: number }[]).forEach((r) => {
    counts[r.reason] = r.c;
  });
  const totalLost = Object.values(counts).reduce((s, n) => s + n, 0) || 1;
  const lostReasons = REASONS.map((r) => {
    const count = counts[r.key] || 0;
    return { label: r.label, tone: r.tone, count, pct: Math.round((count / totalLost) * 100) + '%' };
  });

  return {
    summary: { valueAtRisk: money(valueInPlay), stalled, winRate, avgDays, openCount, needsTouch },
    quotes,
    activeDraft,
    lostReasons,
    lostFooter: 'Win rate and open value are live from ServiceTrade; loss reasons fill in as you mark outcomes.',
    live: true,
  };
}

export function getPipelineSummary(office = '') {
  const db = getDb();
  const realN = (db.prepare(`SELECT COUNT(*) AS v FROM quotes WHERE source = 'servicetrade'`).get() as { v: number }).v || 0;
  if (realN > 0) return realPipelineSummary(office);

  const rows = db
    .prepare(
      `SELECT q.id, q.account_id, q.number, q.title, q.amount_cents, q.stage, q.sent_at, a.name AS customer
         FROM quotes q LEFT JOIN accounts a ON a.id = q.account_id
        WHERE q.stage IN ('lead','quoted','following_up','awaiting_price')
        ORDER BY (q.sent_at IS NULL), q.sent_at ASC`
    )
    .all() as (QuoteRow & { customer: string | null })[];

  const quotes = rows.map((q) => {
    const days = daysSince(q.sent_at);
    const touches = touchCount(q.id);
    const tier = tierFor(days, touches);
    const meta = TIER_META[tier];
    const nm = NEXT_MOVE[tier];
    const ageStr = days == null ? 'not sent' : `day ${days}`;
    return {
      id: q.id,
      customer: q.customer || q.title || 'Prospect',
      work: q.title || '',
      value: money(q.amount_cents),
      age: ageStr,
      ageTone: tier === 'last_call' || tier === 'stalled' ? 'var(--money)' : 'var(--muted)',
      tier: meta.label,
      tierPill: meta.pill,
      touches,
      next: nm.next,
      cta: nm.cta,
      ctaDark: tier === 'last_call',
    };
  });

  // the active right-rail draft: the flagship last-call (surgery-center repairs), else the
  // first last-call quote in the list
  const isLastCall = (q: QuoteRow) => tierFor(daysSince(q.sent_at), touchCount(q.id)) === 'last_call';
  const urgent = rows.find((q) => /surgery center/i.test(q.title || '') && isLastCall(q)) || rows.find(isLastCall);
  let activeDraft = null;
  if (urgent) {
    const value = money(urgent.amount_cents);
    const customer = urgent.customer || urgent.title || 'the customer';
    activeDraft = {
      quoteId: urgent.id,
      title: `${customer} — ${urgent.title || 'quoted work'}`,
      value: `${value} on the line`,
      tier: 'last call · day 7',
      body: templateFollowup('last_call', customer, urgent.title || 'the quoted work', value),
    };
  }

  // why we lose — real counts from lost_reasons, ordered + coloured
  const counts: Record<string, number> = {};
  (db.prepare(`SELECT reason, COUNT(*) AS c FROM lost_reasons GROUP BY reason`).all() as { reason: string; c: number }[]).forEach((r) => {
    counts[r.reason] = r.c;
  });
  const lostReasons = REASONS.map((r) => ({ label: r.label, tone: r.tone, count: counts[r.key] || 0 }));
  const scale = 19; // matches the design's bar widths (price 14 -> 74%)

  return {
    summary: { valueAtRisk: '$412,300', stalled: 11, winRate: '38%', avgDays: 12, openCount: quotes.length, needsTouch: 11 },
    quotes,
    activeDraft,
    lostReasons: lostReasons.map((r) => ({ ...r, pct: Math.round((r.count / scale) * 100) + '%' })),
    lostFooter: '"Too slow to quote" is down from 11 since the Estimator went in.',
    live: false,
  };
}
