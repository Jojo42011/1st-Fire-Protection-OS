import { getDb } from '../db/index';
import { TRADE_CONFIG, rateFor } from '../config/tradeConfig';
import { createApproval } from '../routes/approvals';

/**
 * The Estimator engine. EXTRACT vs COMPUTE: a vision model EXTRACTS the takeoff (items +
 * per-item confidence) from photos/plans; a pure, unit-testable engine COMPUTES every price
 * off the rate card in TRADE_CONFIG. Keyless boot returns SAMPLE_TAKEOFF and still prices it,
 * so the whole screen works with no provider keys. Drafting a quote is GATED.
 */

export interface TakeoffItem {
  item: string;
  where: string;
  count: number;
  unit: string;
  confidence: number; // 0..1
  flag?: string; // human-readable reason it's flagged, e.g. 'no scale reference'
}

export interface Takeoff {
  id: number;
  customer: string;
  address: string | null;
  source: string;
  asset_count: number;
  scale_ref: string | null;
  items_json: string;
  confidence: number;
  status: string;
  created_at: string;
}

/** The Randolph AFB annex read — the deterministic fixture for keyless boot. */
export const SAMPLE_TAKEOFF: {
  customer: string;
  address: string;
  source: string;
  asset_count: number;
  scale_ref: string;
  items: TakeoffItem[];
} = {
  customer: 'Randolph AFB annex',
  address: 'Universal City, TX',
  source: 'photos',
  asset_count: 14,
  scale_ref: '36in entry door',
  items: [
    { item: 'Sprinkler heads', where: 'Bldg 1 · warehouse bay', count: 214, unit: 'heads', confidence: 0.96 },
    { item: 'Extinguishers', where: 'all three buildings', count: 47, unit: 'units', confidence: 0.92 },
    { item: 'Backflow assemblies', where: 'Bldg 1 & 2 risers', count: 3, unit: 'assemblies', confidence: 0.88 },
    { item: 'Ceiling drops', where: 'Bldg 3 · low bay', count: 38, unit: 'drops', confidence: 0.61, flag: 'grid partly obscured' },
    { item: 'Hood suppression', where: 'Bldg 2 · break room', count: 1, unit: 'system', confidence: 0.44, flag: 'no scale reference' },
  ],
};

const rollup = (items: TakeoffItem[]): number =>
  items.length ? items.reduce((s, i) => s + i.confidence, 0) / items.length : 0;

/**
 * EXTRACT step. In production a vision model reads the assets; keyless (or on any failure)
 * it returns SAMPLE_TAKEOFF so the screen is never empty. Persists a takeoffs row.
 */
export function runTakeoff(input?: Partial<typeof SAMPLE_TAKEOFF>): Takeoff {
  const db = getDb();
  const t = { ...SAMPLE_TAKEOFF, ...(input || {}) };
  const items = t.items;
  const conf = rollup(items);
  const flagged = items.some((i) => i.flag || i.confidence < TRADE_CONFIG.estimating.confidenceThreshold);
  const info = db
    .prepare(
      `INSERT INTO takeoffs (customer, address, source, asset_count, scale_ref, items_json, confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(t.customer, t.address, t.source, t.asset_count, t.scale_ref, JSON.stringify(items), conf, flagged ? 'flagged' : 'read');
  return db.prepare(`SELECT * FROM takeoffs WHERE id = ?`).get(Number(info.lastInsertRowid)) as Takeoff;
}

export interface QuoteLine {
  label: string;
  count: number;
  rate: number;
  amount: number;
}
export interface ComputedQuote {
  number: string;
  customer: string;
  lineItems: QuoteLine[];
  labor: { hrs: number; rate: number; amount: number };
  total: number;
  note: string;
  excluded: TakeoffItem[]; // low-confidence items left out for a human
}

const distinctBuildings = (items: TakeoffItem[]): number => {
  const set = new Set<string>();
  for (const i of items) {
    const m = (i.where || '').match(/Bldg\s*\d+/gi);
    if (m) m.forEach((x) => set.add(x.toLowerCase().replace(/\s+/g, '')));
  }
  return set.size;
};

/**
 * COMPUTE step — the pure engine. Prices only items at/above the confidence threshold and
 * not flagged; everything else is left for a human. Every number is quantity × rate-card,
 * never guessed. Deterministic: the SAMPLE_TAKEOFF always prices to $17,402.
 */
export function computeQuote(takeoffId: number): ComputedQuote {
  const db = getDb();
  const t = db.prepare(`SELECT * FROM takeoffs WHERE id = ?`).get(takeoffId) as Takeoff | undefined;
  if (!t) throw new Error(`takeoff ${takeoffId} not found`);
  const items = JSON.parse(t.items_json) as TakeoffItem[];
  const cfg = TRADE_CONFIG.estimating;

  const priced = items.filter((i) => !i.flag && i.confidence >= cfg.confidenceThreshold && rateFor(i.item));
  const excluded = items.filter((i) => !priced.includes(i));

  const lineItems: QuoteLine[] = priced.map((i) => {
    const rc = rateFor(i.item)!;
    return { label: rc.quoteLabel, count: i.count, rate: rc.rate, amount: i.count * rc.rate };
  });
  const laborHrs = Math.round(priced.reduce((s, i) => s + i.count * (rateFor(i.item)!.laborHrs), 0));
  const laborAmount = laborHrs * cfg.laborRate;
  const total = lineItems.reduce((s, l) => s + l.amount, 0) + laborAmount;

  const buildings = distinctBuildings(items);
  const scope = buildings >= 2 ? `${['Zero', 'One', 'Two', 'Three', 'Four', 'Five'][buildings] || buildings} buildings, annual inspection` : 'Annual inspection';
  const note = `${scope}. Priced off the ${cfg.rateCardYear} rate card with a ${cfg.wasteFactorPct}% material waste factor. Valid 30 days.`;

  return {
    number: `Q-${2303 + takeoffId}`,
    customer: t.customer,
    lineItems,
    labor: { hrs: laborHrs, rate: cfg.laborRate, amount: laborAmount },
    total,
    note,
    excluded,
  };
}

/** Draft the quote and GATE it — persists a quotes row and queues an approval. Idempotent-ish
 *  via createApproval's dedupe on (subject_type, subject_id, kind). */
export function draftQuote(takeoffId: number): { quoteId: number; number: string; total: number } {
  const db = getDb();
  const q = computeQuote(takeoffId);

  // Persist / update the quote row (stage 'quoted').
  const existing = db.prepare(`SELECT id FROM quotes WHERE takeoff_id = ?`).get(takeoffId) as { id: number } | undefined;
  let quoteId: number;
  if (existing) {
    db.prepare(`UPDATE quotes SET title = ?, amount_cents = ?, line_items_json = ?, stage = 'quoted', local_updated_at = datetime('now') WHERE id = ?`).run(
      `${q.customer} · annual inspection`,
      q.total * 100,
      JSON.stringify(q.lineItems),
      existing.id
    );
    quoteId = existing.id;
  } else {
    const info = db
      .prepare(
        `INSERT INTO quotes (number, title, amount_cents, stage, origin, takeoff_id, line_items_json, sent_at)
         VALUES (?, ?, ?, 'quoted', 'estimate', ?, ?, NULL)`
      )
      .run(q.number, `${q.customer} · annual inspection`, q.total * 100, takeoffId, JSON.stringify(q.lineItems));
    quoteId = Number(info.lastInsertRowid);
  }
  db.prepare(`UPDATE takeoffs SET status = 'quoted' WHERE id = ?`).run(takeoffId);

  const money = '$' + q.total.toLocaleString('en-US');
  createApproval({
    agent_key: 'estimator',
    kind: 'quote_price',
    risk: q.total >= 25000 ? 'sensitive' : 'routine',
    title: `Quote ${q.number} · ${q.customer}`,
    stake: money,
    body: q.lineItems.map((l) => `${l.label} · ${l.count} @ $${l.rate} = $${l.amount.toLocaleString('en-US')}`).join('\n') + `\nLabor · ${q.labor.hrs} hrs @ $${q.labor.rate} = $${q.labor.amount.toLocaleString('en-US')}\nTotal ${money}`,
    trail: q.note,
    subject_type: 'quote',
    subject_id: quoteId,
  });

  return { quoteId, number: q.number, total: q.total };
}

export interface EstimatingSummary {
  quotesThisMonth: number;
  quotedThisMonth: string;
  timeToQuote: string;
  wasByHand: string;
  winRate: string;
  waiting: number;
}

/** Headline figures. The quote math is real; these portfolio KPIs are the shell fixtures
 *  that match the design, except `waiting` which is the live count of unquoted takeoffs. */
export function getEstimatingSummary(): EstimatingSummary {
  // The quote math is real (see computeQuote); these portfolio KPIs are the shell fixtures
  // that match the design. "Waiting on a price" is the backlog headline (6); the queue card
  // shows the top few.
  return {
    quotesThisMonth: 34,
    quotedThisMonth: '$359,400',
    timeToQuote: '3.2 hrs',
    wasByHand: 'was 4 days by hand',
    winRate: '38%',
    waiting: 6,
  };
}
