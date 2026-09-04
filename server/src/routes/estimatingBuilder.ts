import { Router } from 'express';
import { operatingOffices } from '../os/office';
import { currentContext } from '../os/scope';
import {
  listPriceBook, importPriceBookCsv, upsertItem, deleteItem, seedStarterCatalog,
  getMargins, setMargins,
} from '../services/priceBook';
import {
  listQuotes, createQuote, getQuote, updateQuote, addLine, updateLine, deleteLine, setStatus, deleteQuote,
} from '../services/quotesBuilder';

/**
 * Estimating builder API (Phase 0/1): the per-office price book + margins, and the construction quote
 * builder. Session-gated by the app's normal auth; office is passed by the client. Separate from the
 * ServiceTrade-mirror estimator routes so nothing here touches the sync path.
 */
const router = Router();
const O = (req: any): string => String(req.query.office || req.body?.office || '');

/* ---- offices (for the selector) ---- */
router.get('/api/estimating/offices', (_req, res) => {
  res.json({ ok: true, offices: operatingOffices() });
});

/* ---- price book ---- */
router.get('/api/estimating/pricebook', (req, res) => {
  const office = O(req);
  const q = String(req.query.q || '');
  const { items, total } = listPriceBook(office, q, 600);
  res.json({ ok: true, office, items, total, margins: getMargins(office) });
});

router.post('/api/estimating/pricebook/seed', (_req, res) => {
  res.json({ ok: true, ...seedStarterCatalog() });
});

router.post('/api/estimating/pricebook/import', (req, res) => {
  const b = req.body || {};
  const out = importPriceBookCsv(O(req), String(b.csv || ''), !!b.commit);
  res.status(out.ok ? 200 : 400).json(out);
});

router.post('/api/estimating/pricebook/item', (req, res) => {
  const b = req.body || {};
  const it = upsertItem(O(req), { sku: b.sku, name: b.name, cat: b.cat, unit: b.unit, cost: Number(b.cost), labor_hrs: Number(b.labor_hrs) });
  res.status(it ? 200 : 400).json(it ? { ok: true, item: it } : { ok: false, error: 'SKU required' });
});

router.delete('/api/estimating/pricebook/item/:id(\\d+)', (req, res) => {
  res.json({ ok: deleteItem(Number(req.params.id)) });
});

/* ---- margins ---- */
router.get('/api/estimating/margins', (req, res) => res.json({ ok: true, margins: getMargins(O(req)) }));
router.put('/api/estimating/margins', (req, res) => {
  const b = req.body || {};
  const patch: any = {};
  for (const k of ['labor_rate', 'design_rate', 'mat_markup', 'overhead', 'profit']) if (b[k] !== undefined && b[k] !== '') patch[k] = Number(b[k]);
  res.json({ ok: true, margins: setMargins(O(req), patch) });
});

/* ---- quotes ---- */
router.get('/api/estimating/quotes', (req, res) => {
  res.json({ ok: true, quotes: listQuotes(O(req), String(req.query.status || '')) });
});

router.post('/api/estimating/quotes', (req, res) => {
  const ctx = currentContext(req);
  const who = ctx.user?.display_name || ctx.user?.email || null;
  const q = createQuote({ ...(req.body || {}), office: O(req), created_by: who || undefined });
  res.json({ ok: true, quote: q });
});

router.get('/api/estimating/quotes/:id(\\d+)', (req, res) => {
  const out = getQuote(Number(req.params.id));
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});

router.put('/api/estimating/quotes/:id(\\d+)', (req, res) => {
  const out = updateQuote(Number(req.params.id), req.body || {});
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});

router.post('/api/estimating/quotes/:id(\\d+)/status', (req, res) => {
  const out = setStatus(Number(req.params.id), String((req.body || {}).status || ''));
  res.status(out ? 200 : 400).json(out ? { ok: true, ...out } : { ok: false, error: 'bad status' });
});

router.delete('/api/estimating/quotes/:id(\\d+)', (req, res) => {
  res.json({ ok: deleteQuote(Number(req.params.id)) });
});

/* ---- lines ---- */
router.post('/api/estimating/quotes/:id(\\d+)/line', (req, res) => {
  const out = addLine(Number(req.params.id), req.body || {});
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});
router.put('/api/estimating/lines/:lineId(\\d+)', (req, res) => {
  const out = updateLine(Number(req.params.lineId), req.body || {});
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});
router.delete('/api/estimating/lines/:lineId(\\d+)', (req, res) => {
  const out = deleteLine(Number(req.params.lineId));
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});

export default router;
