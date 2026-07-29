import { Router } from 'express';
import { getDb } from '../db/index';
import { computeQuote, draftQuote, getEstimatingSummary, TakeoffItem, Takeoff } from '../services/estimatorAgent';
import { TRADE_CONFIG } from '../config/tradeConfig';

/**
 * The Estimator (Phase 2). GET serves the active takeoff, its computed quote and the queue —
 * all from seeded fixtures, live:false. POST drafts the quote and queues an approval (gated).
 */
const router = Router();

const money = (n: number) => '$' + Number(n || 0).toLocaleString('en-US');

// confidence → the Signal meaning colour for the bar + flag
function confTone(c: number): string {
  if (c >= TRADE_CONFIG.estimating.confidenceThreshold) return 'var(--green)';
  if (c >= 0.6) return 'var(--amber-ink)';
  return 'var(--money)';
}

function shapeItem(i: TakeoffItem) {
  const pct = Math.round(i.confidence * 100) + '%';
  const tone = confTone(i.confidence);
  return { item: i.item, where: i.where, count: i.count, unit: i.unit, conf: pct, pct, confFg: tone, flag: i.flag || '', flagFg: tone };
}

function queueDetail(t: Takeoff): string {
  const items = JSON.parse(t.items_json || '[]') as TakeoffItem[];
  const scope = items[0]?.item || 'Site read';
  return t.source === 'blueprint' ? `Blueprint · ${t.asset_count} sheets` : `${scope} · ${t.asset_count} photos`;
}
const queueBadge = (t: Takeoff) =>
  t.status === 'flagged' ? { text: 'low scale conf.', tone: 'amber' } : { text: 'read', tone: 'green' };

router.get('/api/estimating', (_req, res) => {
  const db = getDb();
  const active = db.prepare(`SELECT * FROM takeoffs ORDER BY id ASC LIMIT 1`).get() as Takeoff | undefined;

  let activeOut = null;
  let quoteOut = null;
  if (active) {
    const items = (JSON.parse(active.items_json) as TakeoffItem[]).map(shapeItem);
    activeOut = {
      id: active.id,
      customer: active.customer,
      source: active.source,
      photosLabel: `${active.asset_count} ${active.source === 'blueprint' ? 'sheets' : 'photos'} read`,
      scaleRef: active.scale_ref,
      items,
      flaggedCount: items.filter((i) => i.flag).length,
    };
    const q = computeQuote(active.id);
    quoteOut = {
      number: q.number,
      customer: q.customer,
      lineItems: q.lineItems.map((l) => ({ label: l.label, count: l.count, rate: l.rate, amount: money(l.amount), detail: `${l.label} · ${l.count} @ $${l.rate}` })),
      labor: { hrs: q.labor.hrs, rate: q.labor.rate, amount: money(q.labor.amount), detail: `Labor · ${q.labor.hrs} hrs @ $${q.labor.rate}` },
      total: money(q.total),
      note: q.note,
    };
  }

  const queueRows = active
    ? (db.prepare(`SELECT * FROM takeoffs WHERE id != ? AND status != 'quoted' ORDER BY id ASC`).all(active.id) as Takeoff[])
    : [];
  const queue = queueRows.map((t) => {
    const b = queueBadge(t);
    return { id: t.id, customer: t.customer, detail: queueDetail(t), badge: b.text, badgeTone: b.tone };
  });

  res.json({ summary: getEstimatingSummary(), active: activeOut, quote: quoteOut, queue, live: false });
});

router.post('/api/estimating/:id/quote', (req, res) => {
  try {
    const r = draftQuote(Number(req.params.id));
    res.json({ ok: true, ...r, live: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
