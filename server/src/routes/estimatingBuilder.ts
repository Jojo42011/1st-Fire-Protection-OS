import { Router } from 'express';
import { operatingOffices } from '../os/office';
import { currentContext } from '../os/scope';
import {
  listPriceBook, importPriceBookCsv, upsertItem, deleteItem, seedStarterCatalog,
  getMargins, setMargins,
} from '../services/priceBook';
import {
  listQuotes, createQuote, getQuote, updateQuote, addLine, updateLine, deleteLine, setStatus, deleteQuote,
  listOpenDeficiencies, quoteFromDeficiencies, searchAccounts, duplicateQuote, quoteApproved,
} from '../services/quotesBuilder';
import { sendProposal } from '../services/proposalEmail';
import { jobFromQuote, jobForQuote } from '../services/jobsBoard';
import { computeTakeoff, generateTakeoff } from '../services/takeoff';
import { createApproval } from './approvals';

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
  for (const k of ['labor_rate', 'design_rate', 'mat_markup', 'overhead', 'profit', 'floor_markup']) if (b[k] !== undefined && b[k] !== '') patch[k] = Number(b[k]);
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

/* ---- deficiency -> quote (Phase 3) ---- */
router.get('/api/estimating/deficiencies', (req, res) => {
  const items = listOpenDeficiencies(O(req), String(req.query.q || ''), String(req.query.includeQuoted || '') === '1');
  res.json({ ok: true, deficiencies: items });
});

router.post('/api/estimating/quotes/from-deficiencies', (req, res) => {
  const ctx = currentContext(req);
  const who = ctx.user?.display_name || ctx.user?.email || undefined;
  const ids = Array.isArray((req.body || {}).deficiency_ids) ? (req.body.deficiency_ids as any[]).map(Number) : [];
  const out = quoteFromDeficiencies(ids, O(req), who);
  res.status(out ? 200 : 400).json(out ? { ok: true, ...out } : { ok: false, error: 'no deficiencies selected' });
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
  const id = Number(req.params.id);
  const b = req.body || {};
  const status = String(b.status || '');
  const out = setStatus(id, status, b.note !== undefined ? String(b.note) : undefined);
  if (!out) return res.status(400).json({ ok: false, error: 'bad status' });
  // Winning a quote hands it to the field: spawn (or find) its job on the project board.
  let job = null;
  if (status === 'won') { const ctx = currentContext(req); job = jobFromQuote(id, ctx.user?.display_name || ctx.user?.email || undefined); }
  else job = jobForQuote(id);
  res.json({ ok: true, ...out, job });
});

/* ---- Phase 2: parametric auto-takeoff ---- */
// Preview the generated bill of materials for a set of parameters without touching the quote.
router.post('/api/estimating/quotes/:id(\\d+)/takeoff/preview', (req, res) => {
  const d = getQuote(Number(req.params.id));
  if (!d) return res.status(404).json({ ok: false, error: 'not found' });
  const b = req.body || {};
  const lines = computeTakeoff(d.quote.office, {
    sf: b.sf != null ? Number(b.sf) : (Number(d.quote.sf) || 0),
    hazard: b.hazard != null ? String(b.hazard) : (d.quote.hazard || ''),
    system_type: b.system_type != null ? String(b.system_type) : (d.quote.system_type || ''),
    stories: b.stories != null ? Number(b.stories) : (Number(d.quote.stories) || 1),
    type: d.quote.type || 'Fire Sprinkler',
  });
  res.json({ ok: true, lines });
});

router.post('/api/estimating/quotes/:id(\\d+)/takeoff', (req, res) => {
  const b = req.body || {};
  const out = generateTakeoff(Number(req.params.id), {
    replace: !!b.replace,
    sf: b.sf != null && b.sf !== '' ? Number(b.sf) : undefined,
    hazard: b.hazard != null && b.hazard !== '' ? String(b.hazard) : undefined,
    system_type: b.system_type != null && b.system_type !== '' ? String(b.system_type) : undefined,
    stories: b.stories != null && b.stories !== '' ? Number(b.stories) : undefined,
  });
  res.status(out ? 200 : 400).json(out ? { ok: true, ...out } : { ok: false, error: 'Set a square footage first, then run the takeoff.' });
});

/* ---- CRM account link ---- */
router.get('/api/estimating/accounts', (req, res) => {
  res.json({ ok: true, accounts: searchAccounts(String(req.query.q || '')) });
});

/* ---- duplicate ---- */
router.post('/api/estimating/quotes/:id(\\d+)/duplicate', (req, res) => {
  const ctx = currentContext(req);
  const out = duplicateQuote(Number(req.params.id), ctx.user?.display_name || ctx.user?.email || undefined);
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});

/* ---- send proposal, with margin-floor approval routing ---- */
router.post('/api/estimating/quotes/:id(\\d+)/send', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const to = String((req.body || {}).to || '');
    const d = getQuote(id);
    if (!d) return res.status(404).json({ ok: false, error: 'not found' });
    const floor = d.totals.margins.floor_markup;
    // Below the office's margin floor and not already approved: route to the Approvals inbox, don't send.
    if (d.totals.markupPct < floor && !quoteApproved(id)) {
      const money = '$' + Math.round(d.totals.sellPrice).toLocaleString('en-US');
      createApproval({
        agent_key: 'estimator', kind: 'quote_price', risk: d.totals.sellPrice >= 25000 ? 'sensitive' : 'routine',
        title: `Quote ${d.quote.number} · ${d.quote.customer || 'Prospect'} (below margin floor)`,
        stake: money,
        body: `Effective markup ${d.totals.markupPct}% is below the ${floor}% floor.\nSell ${money} · material $${Math.round(d.totals.matCost).toLocaleString('en-US')} · labor ${d.totals.laborHrs} hrs.`,
        trail: to ? `Would email the proposal to ${to}` : 'Proposal ready to send once approved',
        subject_type: 'est_quote', subject_id: id,
      });
      return res.json({ ok: true, needsApproval: true, floor, markup: d.totals.markupPct, ...getQuote(id) });
    }
    const out = await sendProposal(id, to);
    res.status(out.ok ? 200 : 400).json(out.ok ? { ok: true, sent: true, ...getQuote(id) } : { ok: false, error: out.error });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
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
