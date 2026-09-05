import { Router } from 'express';
import { allowedOffices } from '../os/scope';
import {
  requireOs, ctxOf, actorOf, officeKeysOrFail, writeOfficeOrFail, pricingOfficeOrFail, canActOnOffice,
} from '../os/authz';
import { P } from '../os/policy';
import { osAudit } from '../os/audit';
import {
  listPriceBook, importPriceBookCsv, upsertItem, deleteItem, seedStarterCatalog,
  getMargins, setMargins,
} from '../services/priceBook';
import {
  listQuotes, createQuote, getQuote, updateQuote, addLine, updateLine, deleteLine, setStatus, deleteQuote,
  listOpenDeficiencies, quoteFromDeficiencies, searchAccounts, duplicateQuote, quoteApproved,
  quoteOffice, lineQuoteId,
} from '../services/quotesBuilder';
import { generateTakeoff, computeTakeoff } from '../services/takeoff';
import { jobFromQuote, jobForQuote } from '../services/jobsBoard';
import { queueProposalSend, invalidateQuoteActions } from '../services/outbox';

/**
 * Estimating builder API. Every route is guarded by the OS authorization layer (requireOs) and every
 * office is resolved against the caller's authorized scope (never the raw client office). Object-by-id
 * routes verify the target quote/line is inside the caller's office scope so IDs can't cross offices.
 * Price-book and margin edits require the stricter 'pricing' module. Sensitive changes are audited.
 */
const router = Router();

const nonNeg = (v: any): boolean => v === undefined || v === null || v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0);

/** Verify the quote exists and is in the caller's office scope. Sends 404/403 and returns null on failure. */
function scopeQuote(req: any, res: any, id: number): string | null {
  const office = quoteOffice(id);
  if (office === null) { res.status(404).json({ ok: false, error: 'not_found' }); return null; }
  if (!canActOnOffice(req, office)) { res.status(403).json({ ok: false, error: 'office_forbidden' }); return null; }
  return office;
}

/* ---- offices (only the caller's authorized offices) ---- */
router.get('/api/estimating/offices', requireOs(P.estimating_read), (req, res) => {
  res.json({ ok: true, offices: allowedOffices(ctxOf(req)) });
});

/* ---- price book (pricing module) ---- */
router.get('/api/estimating/pricebook', requireOs(P.pricing_read), (req, res) => {
  const office = pricingOfficeOrFail(req, res); if (office === null) return;
  const q = String(req.query.q || '');
  const { items, total } = listPriceBook(office, q, 600);
  res.json({ ok: true, office, items, total, margins: getMargins(office) });
});

router.post('/api/estimating/pricebook/seed', requireOs(P.pricing_write), (req, res) => {
  const out = seedStarterCatalog();
  osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, module: 'pricing', action: 'pricebook.seed', new_summary: `${out.inserted} items` });
  res.json({ ok: true, ...out });
});

router.post('/api/estimating/pricebook/import', requireOs(P.pricing_write), (req, res) => {
  const office = pricingOfficeOrFail(req, res); if (office === null) return;
  const b = req.body || {};
  const out = importPriceBookCsv(office, String(b.csv || ''), !!b.commit);
  if (out.ok && b.commit) osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office, module: 'pricing', action: 'pricebook.import', new_summary: `${out.imported} imported` });
  res.status(out.ok ? 200 : 400).json(out);
});

router.post('/api/estimating/pricebook/item', requireOs(P.pricing_write), (req, res) => {
  const office = pricingOfficeOrFail(req, res); if (office === null) return;
  const b = req.body || {};
  if (!nonNeg(b.cost) || !nonNeg(b.labor_hrs)) return res.status(400).json({ ok: false, error: 'invalid_value', hint: 'cost and labor hours must be zero or positive.' });
  const it = upsertItem(office, { sku: b.sku, name: b.name, cat: b.cat, unit: b.unit, cost: Number(b.cost), labor_hrs: Number(b.labor_hrs) });
  if (it) osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office, module: 'pricing', action: 'pricebook.upsert', subject_type: 'price_item', subject_id: it.sku, new_summary: `${it.name} $${it.cost}` });
  res.status(it ? 200 : 400).json(it ? { ok: true, item: it } : { ok: false, error: 'SKU required' });
});

router.delete('/api/estimating/pricebook/item/:id(\\d+)', requireOs(P.pricing_write), (req, res) => {
  const ok = deleteItem(Number(req.params.id));
  if (ok) osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, module: 'pricing', action: 'pricebook.delete', subject_type: 'price_item', subject_id: req.params.id });
  res.json({ ok });
});

/* ---- margins (pricing module) ---- */
router.get('/api/estimating/margins', requireOs(P.pricing_read), (req, res) => {
  const office = pricingOfficeOrFail(req, res); if (office === null) return;
  res.json({ ok: true, margins: getMargins(office) });
});
router.put('/api/estimating/margins', requireOs(P.pricing_write), (req, res) => {
  const office = pricingOfficeOrFail(req, res); if (office === null) return;
  const b = req.body || {};
  const patch: any = {};
  for (const k of ['labor_rate', 'design_rate', 'mat_markup', 'overhead', 'profit', 'floor_markup']) {
    if (b[k] !== undefined && b[k] !== '') {
      if (!nonNeg(b[k])) return res.status(400).json({ ok: false, error: 'invalid_value', hint: `${k} must be zero or positive.` });
      patch[k] = Number(b[k]);
    }
  }
  const before = getMargins(office);
  const margins = setMargins(office, patch);
  osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office, module: 'pricing', action: 'margin.update', old_summary: `markup ${before.mat_markup} floor ${before.floor_markup}`, new_summary: JSON.stringify(patch) });
  res.json({ ok: true, margins });
});

/* ---- quotes ---- */
router.get('/api/estimating/quotes', requireOs(P.estimating_read), (req, res) => {
  const scope = officeKeysOrFail(req, res); if (scope === null) return;
  res.json({ ok: true, quotes: listQuotes(scope === 'ALL' ? null : scope, String(req.query.status || '')) });
});

router.post('/api/estimating/quotes', requireOs(P.estimating_write), (req, res) => {
  const office = writeOfficeOrFail(req, res); if (office === null) return;
  const who = actorOf(req);
  const q = createQuote({ ...(req.body || {}), office, created_by: who.label });
  osAudit({ actor: who.label, actor_email: who.email, office, module: 'deficiencies', action: 'quote.create', subject_type: 'est_quote', subject_id: q.id, new_summary: `${q.number} ${q.customer || ''}` });
  res.json({ ok: true, quote: q });
});

/* ---- deficiency -> quote (Phase 3) ---- */
router.get('/api/estimating/deficiencies', requireOs(P.estimating_read), (req, res) => {
  // '' = company-wide (allOffices) sees all; a scoped caller is pinned to their office.
  const office = pricingOfficeOrFail(req, res); if (office === null) return;
  const items = listOpenDeficiencies(office, String(req.query.q || ''), String(req.query.includeQuoted || '') === '1');
  res.json({ ok: true, deficiencies: items });
});

router.post('/api/estimating/quotes/from-deficiencies', requireOs(P.estimating_write), (req, res) => {
  const office = writeOfficeOrFail(req, res); if (office === null) return;
  const who = actorOf(req);
  const ids = Array.isArray((req.body || {}).deficiency_ids) ? (req.body.deficiency_ids as any[]).map(Number) : [];
  const out = quoteFromDeficiencies(ids, office, who.label);
  if (out) osAudit({ actor: who.label, actor_email: who.email, office, module: 'deficiencies', action: 'quote.create', subject_type: 'est_quote', subject_id: out.quote.id, new_summary: `repair from ${ids.length} deficiencies` });
  res.status(out ? 200 : 400).json(out ? { ok: true, ...out } : { ok: false, error: 'no deficiencies selected' });
});

router.get('/api/estimating/quotes/:id(\\d+)', requireOs(P.estimating_read), (req, res) => {
  const id = Number(req.params.id);
  if (scopeQuote(req, res, id) === null) return;
  const out = getQuote(id);
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});

router.put('/api/estimating/quotes/:id(\\d+)', requireOs(P.estimating_write), (req, res) => {
  const id = Number(req.params.id);
  const office = scopeQuote(req, res, id); if (office === null) return;
  const out = updateQuote(id, req.body || {});
  if (out) {
    invalidateQuoteActions(id); // an edit supersedes any pending proposal approval
    osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office, module: 'deficiencies', action: 'quote.update', subject_type: 'est_quote', subject_id: id, new_summary: Object.keys(req.body || {}).join(',') });
  }
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});

const VALID_STATUS = ['draft', 'sent', 'won', 'lost'];
router.post('/api/estimating/quotes/:id(\\d+)/status', requireOs(P.estimating_write), (req, res) => {
  const id = Number(req.params.id);
  const office = scopeQuote(req, res, id); if (office === null) return;
  const b = req.body || {};
  const status = String(b.status || '');
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ ok: false, error: 'invalid_status' });
  const out = setStatus(id, status, b.note !== undefined ? String(b.note) : undefined);
  if (!out) return res.status(400).json({ ok: false, error: 'bad status' });
  osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office, module: 'deficiencies', action: 'quote.status', subject_type: 'est_quote', subject_id: id, new_summary: status });
  let job = null;
  if (status === 'won') job = jobFromQuote(id, actorOf(req).label);
  else job = jobForQuote(id);
  res.json({ ok: true, ...out, job });
});

/* ---- CRM account link (scoped) ---- */
router.get('/api/estimating/accounts', requireOs(P.estimating_read), (req, res) => {
  const scope = officeKeysOrFail(req, res); if (scope === null) return;
  res.json({ ok: true, accounts: searchAccounts(String(req.query.q || ''), scope === 'ALL' ? null : scope) });
});

/* ---- duplicate ---- */
router.post('/api/estimating/quotes/:id(\\d+)/duplicate', requireOs(P.estimating_write), (req, res) => {
  const id = Number(req.params.id);
  const office = scopeQuote(req, res, id); if (office === null) return;
  const who = actorOf(req);
  const out = duplicateQuote(id, who.label);
  if (out) osAudit({ actor: who.label, actor_email: who.email, office, module: 'deficiencies', action: 'quote.duplicate', subject_type: 'est_quote', subject_id: out.quote.id, new_summary: `from ${id}` });
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});

/* ---- Phase 2: parametric auto-takeoff ---- */
router.post('/api/estimating/quotes/:id(\\d+)/takeoff/preview', requireOs(P.estimating_write), (req, res) => {
  const id = Number(req.params.id);
  if (scopeQuote(req, res, id) === null) return;
  const d = getQuote(id);
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

router.post('/api/estimating/quotes/:id(\\d+)/takeoff', requireOs(P.estimating_write), (req, res) => {
  const id = Number(req.params.id);
  const office = scopeQuote(req, res, id); if (office === null) return;
  const b = req.body || {};
  for (const k of ['sf', 'stories']) if (b[k] !== undefined && b[k] !== '' && !nonNeg(b[k])) return res.status(400).json({ ok: false, error: 'invalid_value' });
  const out = generateTakeoff(id, {
    replace: !!b.replace,
    sf: b.sf != null && b.sf !== '' ? Number(b.sf) : undefined,
    hazard: b.hazard != null && b.hazard !== '' ? String(b.hazard) : undefined,
    system_type: b.system_type != null && b.system_type !== '' ? String(b.system_type) : undefined,
    stories: b.stories != null && b.stories !== '' ? Number(b.stories) : undefined,
  });
  if (out) {
    invalidateQuoteActions(id);
    osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office, module: 'deficiencies', action: 'quote.takeoff', subject_type: 'est_quote', subject_id: id, new_summary: `${out.generated} lines` });
  }
  res.status(out ? 200 : 400).json(out ? { ok: true, ...out } : { ok: false, error: 'Set a square footage first, then run the takeoff.' });
});

/* ---- send proposal: ALWAYS draft-first through approval + the outbox ---- */
router.post('/api/estimating/quotes/:id(\\d+)/send', requireOs(P.proposal_send), (req, res) => {
  const id = Number(req.params.id);
  const office = scopeQuote(req, res, id); if (office === null) return;
  const to = String((req.body || {}).to || '').trim();
  const d = getQuote(id);
  if (!d) return res.status(404).json({ ok: false, error: 'not found' });
  const floor = d.totals.margins.floor_markup;
  const belowFloor = d.totals.markupPct < floor && !quoteApproved(id);
  const who = actorOf(req);
  const q = queueProposalSend({ quoteId: id, recipient: to, actor: who.label, office, belowFloor, floor, markup: d.totals.markupPct });
  if (!q.ok) return res.status(400).json({ ok: false, error: q.error === 'invalid_email' ? 'A valid recipient email is required.' : q.error });
  osAudit({ actor: who.label, actor_email: who.email, office, module: 'deficiencies', action: 'proposal.queued', subject_type: 'est_quote', subject_id: id, new_summary: `to ${to}`, detail: q.already ? 'already sent (idempotent)' : `revision ${q.revision}` });
  res.json({ ok: true, needsApproval: !q.already, alreadySent: !!q.already, approvalId: q.approvalId, floor, markup: d.totals.markupPct, ...getQuote(id) });
});

router.delete('/api/estimating/quotes/:id(\\d+)', requireOs(P.estimating_write), (req, res) => {
  const id = Number(req.params.id);
  const office = scopeQuote(req, res, id); if (office === null) return;
  const ok = deleteQuote(id);
  if (ok) {
    invalidateQuoteActions(id);
    osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office, module: 'deficiencies', action: 'quote.delete', subject_type: 'est_quote', subject_id: id, detail: 'soft-deleted (archived)' });
  }
  res.json({ ok });
});

/* ---- lines (scoped via their quote) ---- */
router.post('/api/estimating/quotes/:id(\\d+)/line', requireOs(P.estimating_write), (req, res) => {
  const id = Number(req.params.id);
  const office = scopeQuote(req, res, id); if (office === null) return;
  const b = req.body || {};
  if (!nonNeg(b.qty) || !nonNeg(b.cost) || !nonNeg(b.hrs)) return res.status(400).json({ ok: false, error: 'invalid_value' });
  const out = addLine(id, b);
  if (out) { invalidateQuoteActions(id); osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office, module: 'deficiencies', action: 'quote.line.add', subject_type: 'est_quote', subject_id: id }); }
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});
router.put('/api/estimating/lines/:lineId(\\d+)', requireOs(P.estimating_write), (req, res) => {
  const lineId = Number(req.params.lineId);
  const qid = lineQuoteId(lineId);
  if (qid === null) return res.status(404).json({ ok: false, error: 'not found' });
  const office = scopeQuote(req, res, qid); if (office === null) return;
  const b = req.body || {};
  if (!nonNeg(b.qty) || !nonNeg(b.cost) || !nonNeg(b.hrs)) return res.status(400).json({ ok: false, error: 'invalid_value' });
  const out = updateLine(lineId, b);
  if (out) { invalidateQuoteActions(qid); osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office, module: 'deficiencies', action: 'quote.line.update', subject_type: 'est_quote', subject_id: qid }); }
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});
router.delete('/api/estimating/lines/:lineId(\\d+)', requireOs(P.estimating_write), (req, res) => {
  const lineId = Number(req.params.lineId);
  const qid = lineQuoteId(lineId);
  if (qid === null) return res.status(404).json({ ok: false, error: 'not found' });
  const office = scopeQuote(req, res, qid); if (office === null) return;
  const out = deleteLine(lineId);
  if (out) { invalidateQuoteActions(qid); osAudit({ actor: actorOf(req).label, actor_email: actorOf(req).email, office, module: 'deficiencies', action: 'quote.line.delete', subject_type: 'est_quote', subject_id: qid }); }
  res.status(out ? 200 : 404).json(out ? { ok: true, ...out } : { ok: false, error: 'not found' });
});

export default router;
