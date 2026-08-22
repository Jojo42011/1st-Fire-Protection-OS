import { Router } from 'express';
import { getDb } from '../db/index';
import { canonicalOffice } from '../os/office';
import { computeQuote, draftQuote, getEstimatingSummary, TakeoffItem, Takeoff } from '../services/estimatorAgent';
import { TRADE_CONFIG } from '../config/tradeConfig';
import { hasRealQuotes } from '../services/servicetradeSync';

/**
 * The Estimator (Phase 2). When ServiceTrade quotes are present, GET serves the real estimate
 * worklist — every DRAFT quote (built, not yet sent) prioritized by value and age, so the estimator
 * knows exactly what to price and send next. With no real data it falls back to the seeded takeoff
 * demo (live:false). Read-only: the ServiceTrade deep-link is the only "action"; nothing is written.
 */
const router = Router();

const money = (n: number) => '$' + Number(n || 0).toLocaleString('en-US');
// ServiceTrade web app base for deep-linking a quote the estimator can open and work.
const ST_APP = 'https://app.servicetrade.com';

interface DraftRow {
  id: number; st_id: string | null; number: string | null; title: string | null;
  amount_cents: number | null; st_updated_at: string | null; customer: string | null;
}

function ageInfo(iso: string | null): { days: number | null; label: string; tone: string } {
  if (!iso) return { days: null, label: 'n/a', tone: 'var(--muted)' };
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  const label = days < 1 ? 'today' : days < 14 ? `${days}d` : days < 60 ? `${Math.round(days / 7)}w` : `${Math.round(days / 30)}mo`;
  const tone = days < 7 ? 'var(--green)' : days < 30 ? 'var(--amber-ink)' : 'var(--money)';
  return { days, label, tone };
}

/**
 * The live worklist: DRAFT ServiceTrade quotes (the estimator's real backlog). Unpriced drafts
 * ($0) surface with a "needs price" flag; priced drafts are ready to send. Sorted so the biggest
 * dollars are on top, with the oldest called out in the KPIs.
 */
function realWorklist(db: ReturnType<typeof getDb>, office = '') {
  office = office ? (canonicalOffice(office) || office) : '';
  const officeClause = office ? ' AND os_office_key(q.office) = @office' : '';
  const stmt = db.prepare(
    `SELECT q.id, q.st_id, q.number, q.title, q.amount_cents, q.st_updated_at, a.name AS customer
       FROM quotes q LEFT JOIN accounts a ON a.id = q.account_id
      WHERE q.source = 'servicetrade' AND lower(q.stage) = 'draft'${officeClause}
      ORDER BY (q.amount_cents IS NULL OR q.amount_cents = 0) DESC, q.amount_cents DESC`
  );
  const rows = (office ? stmt.all({ office }) : stmt.all()) as DraftRow[];

  const totalCents = rows.reduce((a, q) => a + (q.amount_cents || 0), 0);
  const unpriced = rows.filter((q) => !q.amount_cents).length;
  const ages = rows.map((q) => ageInfo(q.st_updated_at).days).filter((d): d is number => d != null);
  const oldest = ages.length ? Math.max(...ages) : 0;
  const avg = ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;

  const worklist = rows.map((q) => {
    const age = ageInfo(q.st_updated_at);
    return {
      id: q.id,
      number: q.number || 'n/a',
      customer: q.customer || 'Prospect',
      title: q.title || 'Untitled quote',
      amount: q.amount_cents ? money(Math.round(q.amount_cents / 100)) : 'n/a',
      needsPrice: !q.amount_cents,
      age: age.label,
      ageTone: age.tone,
      stUrl: q.st_id ? `${ST_APP}/quotes/${q.st_id}` : null,
    };
  });

  return {
    live: true,
    summary: {
      drafts: rows.length,
      value: money(Math.round(totalCents / 100)),
      unpriced,
      oldestLabel: oldest ? ageInfo(new Date(Date.now() - oldest * 86400000).toISOString()).label : 'n/a',
      avgLabel: avg ? (avg < 14 ? `${avg}d` : `${Math.round(avg / 7)}w`) : 'n/a',
    },
    worklist,
  };
}

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

router.get('/api/estimating', (req, res) => {
  const db = getDb();

  // Live mode: real ServiceTrade draft backlog is the estimator's worklist.
  if (hasRealQuotes()) return res.json(realWorklist(db, String(req.query.office || '')));

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
