import { getDb } from '../db/index';
import { canonicalOffice } from '../os/office';
import { getMargins, getItemBySku, sellPrice, Margins } from './priceBook';
import { officeBranding, OfficeBranding } from './officeBranding';

/**
 * The construction quote builder (Phase 1). An OS-native quote assembled from price-book line items,
 * priced with the office's margin build-up, and turned into a customer proposal. Stored in est_quotes
 * / est_quote_lines, entirely separate from the ServiceTrade quote mirror.
 */

export interface QuoteLine { id: number; quote_id: number; sku: string | null; name: string | null; unit: string | null; cat: string | null; qty: number; cost: number; hrs: number; sort: number; }
export interface Quote {
  id: number; number: string | null; office: string; account_id: number | null; site_id: number | null;
  customer: string | null; address: string | null; contact: string | null; title: string | null; type: string;
  status: string; sf: number | null; stories: number | null; hazard: string | null; system_type: string | null; construction: string | null;
  rates_json: string | null; sell_price: number; mat_cost: number; labor_hrs: number;
  scope: string | null; inclusions: string | null; exclusions: string | null; notes: string | null;
  created_by: string | null; created_at: string; updated_at: string;
}
export interface QuoteTotals { matCost: number; laborHrs: number; laborCost: number; sellPrice: number; margins: Margins; markupPct: number; }
export interface QuoteWithLines { quote: Quote; lines: QuoteLine[]; totals: QuoteTotals; branding: OfficeBranding; }

const off = (raw: string | null | undefined): string => (raw ? canonicalOffice(raw) || '' : '');

/** Search CRM accounts by name for linking a quote to a real customer. */
export function searchAccounts(q: string, limit = 20): Array<{ id: number; name: string }> {
  const term = String(q || '').trim();
  if (!term) return [];
  return getDb().prepare(`SELECT id, name FROM accounts WHERE name LIKE ? ORDER BY name LIMIT ?`).all(`%${term}%`, limit) as any[];
}
const accountName = (id: number | null | undefined): string | null => {
  if (!id) return null;
  const r = getDb().prepare(`SELECT name FROM accounts WHERE id = ?`).get(id) as { name: string } | undefined;
  return r ? r.name : null;
};

function nextNumber(): string {
  const db = getDb();
  const row = db.prepare(`SELECT number FROM est_quotes WHERE number LIKE 'FP-%' ORDER BY id DESC LIMIT 1`).get() as { number: string } | undefined;
  const last = row ? parseInt(String(row.number).replace(/\D/g, ''), 10) || 1000 : 1000;
  return `FP-${last + 1}`;
}

const DEFAULT_EXCLUSIONS = [
  'Fire alarm, unless specifically listed above',
  'Cutting, patching, or painting of building finishes',
  'Cleaning, prepping, or painting of any fire sprinkler pipe, valves, or sprinklers',
  'Access panels, backflow enclosures, and heat in areas subject to freezing',
  'Permit and plan-review fees beyond those listed',
  'Overtime or after-hours work unless noted',
].join('\n');

/* ─────────────────────────── totals ─────────────────────────── */

export function computeTotals(quoteId: number, office: string, rates?: Margins): QuoteTotals {
  const db = getDb();
  const lines = db.prepare(`SELECT * FROM est_quote_lines WHERE quote_id = ?`).all(quoteId) as QuoteLine[];
  const matCost = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
  const laborHrs = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.hrs) || 0), 0);
  const m = rates || getMargins(office);
  const sp = sellPrice(matCost, laborHrs, 0, m);
  const laborCost = laborHrs * m.labor_rate;
  const markupPct = matCost + laborCost > 0 ? Math.round(((sp / (matCost + laborCost)) - 1) * 100) : 0;
  return { matCost: Math.round(matCost * 100) / 100, laborHrs: Math.round(laborHrs * 10) / 10, laborCost: Math.round(laborCost), sellPrice: sp, margins: m, markupPct };
}

/** Recompute and persist the quote's stored totals (material, hours, sell price). */
function persistTotals(quoteId: number): QuoteTotals {
  const db = getDb();
  const q = db.prepare(`SELECT office, rates_json FROM est_quotes WHERE id = ?`).get(quoteId) as { office: string; rates_json: string | null } | undefined;
  if (!q) throw new Error('quote not found');
  let rates: Margins | undefined; try { rates = q.rates_json ? { office: q.office, ...JSON.parse(q.rates_json), floor_markup: getMargins(q.office).floor_markup } : undefined; } catch { rates = undefined; }
  const t = computeTotals(quoteId, q.office, rates);
  db.prepare(`UPDATE est_quotes SET sell_price=?, mat_cost=?, labor_hrs=?, updated_at=datetime('now') WHERE id=?`)
    .run(t.sellPrice, t.matCost, t.laborHrs, quoteId);
  return t;
}

/* ─────────────────────────── CRUD ─────────────────────────── */

export function listQuotes(office = '', status = ''): Array<Quote & { customer_name: string }> {
  const db = getDb();
  const key = off(office);
  const where: string[] = []; const args: any = {};
  if (key) { where.push('office = @office'); args.office = key; }
  if (status) { where.push('status = @status'); args.status = status; }
  const sql = `SELECT * FROM est_quotes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 300`;
  return (db.prepare(sql).all(args) as Quote[]).map((q) => ({ ...q, customer_name: q.customer || 'Prospect' }));
}

export function createQuote(input: Partial<Quote> & { created_by?: string }): Quote {
  const db = getDb();
  const key = off(input.office);
  const rates = getMargins(key);
  const info = db.prepare(
    `INSERT INTO est_quotes (number, office, account_id, site_id, customer, address, contact, title, type, status,
       sf, stories, hazard, system_type, construction, rates_json, scope, inclusions, exclusions, notes, created_by)
     VALUES (@number,@office,@account_id,@site_id,@customer,@address,@contact,@title,@type,'draft',
       @sf,@stories,@hazard,@system_type,@construction,@rates_json,@scope,@inclusions,@exclusions,@notes,@created_by)`
  ).run({
    number: nextNumber(), office: key, account_id: input.account_id ?? null, site_id: input.site_id ?? null,
    customer: input.customer || '', address: input.address || '', contact: input.contact || '',
    title: input.title || 'Fire sprinkler system', type: input.type || 'Fire Sprinkler',
    sf: input.sf ?? null, stories: input.stories ?? 1, hazard: input.hazard || 'Light Hazard',
    system_type: input.system_type || 'Wet pipe', construction: input.construction || 'New construction',
    rates_json: JSON.stringify({ labor_rate: rates.labor_rate, design_rate: rates.design_rate, mat_markup: rates.mat_markup, overhead: rates.overhead, profit: rates.profit }),
    scope: input.scope || '', inclusions: input.inclusions || '', exclusions: input.exclusions || DEFAULT_EXCLUSIONS,
    notes: input.notes || '', created_by: input.created_by || null,
  });
  return getQuote(Number(info.lastInsertRowid))!.quote;
}

const QUOTE_FIELDS = new Set(['customer', 'address', 'contact', 'title', 'type', 'account_id', 'site_id', 'sf', 'stories', 'hazard', 'system_type', 'construction', 'scope', 'inclusions', 'exclusions', 'notes', 'status']);

export function updateQuote(id: number, patch: Record<string, any>): QuoteWithLines | null {
  const db = getDb();
  // Linking to an account with no customer name yet fills the customer from the account.
  if (patch.account_id && (patch.customer === undefined || patch.customer === '')) {
    const cur = db.prepare(`SELECT customer FROM est_quotes WHERE id = ?`).get(id) as { customer: string } | undefined;
    if (!cur?.customer) { const n = accountName(Number(patch.account_id)); if (n) patch.customer = n; }
  }
  const sets: string[] = []; const args: any = { id };
  for (const [k, v] of Object.entries(patch)) { if (QUOTE_FIELDS.has(k)) { sets.push(`${k} = @${k}`); args[k] = v; } }
  // Allow editing the margin snapshot for this quote.
  if (patch.rates && typeof patch.rates === 'object') { sets.push(`rates_json = @rates_json`); args.rates_json = JSON.stringify(patch.rates); }
  if (sets.length) { db.prepare(`UPDATE est_quotes SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=@id`).run(args); }
  persistTotals(id);
  return getQuote(id);
}

export function getQuote(id: number): QuoteWithLines | null {
  const db = getDb();
  const quote = db.prepare(`SELECT * FROM est_quotes WHERE id = ?`).get(id) as Quote | undefined;
  if (!quote) return null;
  const lines = db.prepare(`SELECT * FROM est_quote_lines WHERE quote_id = ? ORDER BY sort, id`).all(id) as QuoteLine[];
  let rates: Margins | undefined; try { rates = quote.rates_json ? { office: quote.office, ...JSON.parse(quote.rates_json), floor_markup: getMargins(quote.office).floor_markup } : undefined; } catch { rates = undefined; }
  const totals = computeTotals(id, quote.office, rates);
  return { quote, lines, totals, branding: officeBranding(quote.office) };
}

/* ─────────────────────────── lines ─────────────────────────── */

/** Add a line from the price book (by SKU) or a manual line. Quantity defaults to 1. */
export function addLine(quoteId: number, input: { sku?: string; name?: string; unit?: string; cat?: string; qty?: number; cost?: number; hrs?: number }): QuoteWithLines | null {
  const db = getDb();
  const q = db.prepare(`SELECT office FROM est_quotes WHERE id = ?`).get(quoteId) as { office: string } | undefined;
  if (!q) return null;
  let line = { sku: input.sku || null as string | null, name: input.name || '', unit: input.unit || '', cat: input.cat || '', qty: Number(input.qty) || 1, cost: Number(input.cost) || 0, hrs: Number(input.hrs) || 0 };
  if (input.sku && (input.cost === undefined || input.name === undefined)) {
    const it = getItemBySku(q.office, input.sku);
    if (it) line = { sku: it.sku, name: input.name || it.name || '', unit: it.unit || '', cat: it.cat || '', qty: line.qty, cost: input.cost ?? (it.cost || 0), hrs: input.hrs ?? (it.labor_hrs || 0) };
  }
  const maxSort = (db.prepare(`SELECT COALESCE(MAX(sort),0) m FROM est_quote_lines WHERE quote_id = ?`).get(quoteId) as { m: number }).m;
  db.prepare(`INSERT INTO est_quote_lines (quote_id, sku, name, unit, cat, qty, cost, hrs, sort) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(quoteId, line.sku, line.name, line.unit, line.cat, line.qty, line.cost, line.hrs, maxSort + 1);
  persistTotals(quoteId);
  return getQuote(quoteId);
}

export function updateLine(lineId: number, patch: { qty?: number; cost?: number; hrs?: number; name?: string; unit?: string }): QuoteWithLines | null {
  const db = getDb();
  const row = db.prepare(`SELECT quote_id FROM est_quote_lines WHERE id = ?`).get(lineId) as { quote_id: number } | undefined;
  if (!row) return null;
  const sets: string[] = []; const args: any = { id: lineId };
  for (const k of ['qty', 'cost', 'hrs', 'name', 'unit'] as const) if (patch[k] !== undefined) { sets.push(`${k} = @${k}`); args[k] = patch[k]; }
  if (sets.length) db.prepare(`UPDATE est_quote_lines SET ${sets.join(', ')} WHERE id = @id`).run(args);
  persistTotals(row.quote_id);
  return getQuote(row.quote_id);
}

export function deleteLine(lineId: number): QuoteWithLines | null {
  const db = getDb();
  const row = db.prepare(`SELECT quote_id FROM est_quote_lines WHERE id = ?`).get(lineId) as { quote_id: number } | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM est_quote_lines WHERE id = ?`).run(lineId);
  persistTotals(row.quote_id);
  return getQuote(row.quote_id);
}

export function setStatus(id: number, status: string, note?: string): QuoteWithLines | null {
  if (!['draft', 'sent', 'won', 'lost'].includes(status)) return null;
  const db = getDb();
  if (note !== undefined) db.prepare(`UPDATE est_quotes SET status = ?, outcome_note = ?, updated_at = datetime('now') WHERE id = ?`).run(status, note || null, id);
  else db.prepare(`UPDATE est_quotes SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  return getQuote(id);
}

/** Copy a quote and all its lines into a fresh draft with a new number. */
export function duplicateQuote(id: number, createdBy?: string): QuoteWithLines | null {
  const db = getDb();
  const src = db.prepare(`SELECT * FROM est_quotes WHERE id = ?`).get(id) as Quote | undefined;
  if (!src) return null;
  const info = db.prepare(
    `INSERT INTO est_quotes (number, office, account_id, site_id, customer, address, contact, title, type, status,
       sf, stories, hazard, system_type, construction, rates_json, scope, inclusions, exclusions, notes, created_by)
     SELECT ?, office, account_id, site_id, customer, address, contact, title || ' (copy)', type, 'draft',
       sf, stories, hazard, system_type, construction, rates_json, scope, inclusions, exclusions, notes, ?
     FROM est_quotes WHERE id = ?`
  ).run(nextNumber(), createdBy || null, id);
  const newId = Number(info.lastInsertRowid);
  db.prepare(`INSERT INTO est_quote_lines (quote_id, sku, name, unit, cat, qty, cost, hrs, sort)
     SELECT ?, sku, name, unit, cat, qty, cost, hrs, sort FROM est_quote_lines WHERE quote_id = ?`).run(newId, id);
  persistTotals(newId);
  return getQuote(newId);
}

/** Whether a manager has already approved this quote in the Approvals inbox. */
export function quoteApproved(id: number): boolean {
  return !!getDb().prepare(
    `SELECT 1 FROM approvals WHERE subject_type = 'est_quote' AND subject_id = ? AND kind = 'quote_price' AND status = 'approved' LIMIT 1`
  ).get(id);
}

export function deleteQuote(id: number): boolean {
  const db = getDb();
  db.prepare(`DELETE FROM est_quote_lines WHERE quote_id = ?`).run(id);
  return db.prepare(`DELETE FROM est_quotes WHERE id = ?`).run(id).changes > 0;
}

/* ─────────────────────────── deficiency → quote (Phase 3) ─────────────────────────── */

// Mirrors deficiencySync.CLOSED_STATUSES so "open" here means the same thing as on the deficiencies board.
const DEFICIENCY_CLOSED = ['fixed', 'invalid', 'canceled', 'cancelled', 'deleted', 'closed'];
const OPEN_DEF = `lower(COALESCE(status,'')) NOT IN (${DEFICIENCY_CLOSED.map((s) => `'${s}'`).join(',')})`;

export interface OpenDeficiency {
  id: number; account_id: number | null; company_name: string | null; location_name: string | null;
  description: string | null; severity: string | null; proposed_usd: number; office: string | null; reported_at: string | null; quoted: number;
}

/** Open, not-yet-quoted deficiencies to build a repair quote from. Optional office scope + text search. */
export function listOpenDeficiencies(office = '', q = '', includeQuoted = false, limit = 400): OpenDeficiency[] {
  const db = getDb();
  const key = off(office);
  const where = [OPEN_DEF]; const args: any = {};
  if (!includeQuoted) where.push('COALESCE(quoted,0) = 0');
  if (key) { where.push('os_office_key(office) = @office'); args.office = key; }
  const term = q.trim();
  if (term) { where.push('(company_name LIKE @q OR location_name LIKE @q OR description LIKE @q)'); args.q = `%${term}%`; }
  const sql = `SELECT id, account_id, company_name, location_name, description, severity, proposed_usd, office, reported_at, quoted
     FROM deficiencies WHERE ${where.join(' AND ')}
     ORDER BY company_name, location_name, proposed_usd DESC, id DESC LIMIT ${Math.min(limit, 1000)}`;
  return db.prepare(sql).all(args) as OpenDeficiency[];
}

/** Build a draft repair quote from selected deficiencies: one line per deficiency (estimator prices
 *  it), customer/site pulled from the deficiencies, and each source deficiency marked quoted. */
export function quoteFromDeficiencies(ids: number[], office: string, createdBy?: string): QuoteWithLines | null {
  const db = getDb();
  const clean = [...new Set((ids || []).map((n) => Number(n)).filter((n) => Number.isFinite(n)))];
  if (!clean.length) return null;
  const rows = db.prepare(`SELECT * FROM deficiencies WHERE id IN (${clean.map(() => '?').join(',')})`).all(...clean) as any[];
  if (!rows.length) return null;

  // Header comes from the most common company on the selection.
  const tally = new Map<string, number>();
  for (const r of rows) { const k = r.company_name || ''; tally.set(k, (tally.get(k) || 0) + 1); }
  const topCompany = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || rows[0].company_name || 'Customer';
  const head = rows.find((r) => (r.company_name || '') === topCompany) || rows[0];
  const key = off(office) || off(head.office) || '';
  const scope = 'Repair the following deficiencies found during inspection:\n' + rows.map((r) => `- ${r.description || 'deficiency'}${r.location_name ? ` (${r.location_name})` : ''}`).join('\n');

  const quote = createQuote({
    office: key, account_id: head.account_id ?? null, customer: topCompany, address: head.location_name || '',
    title: `Repair - ${head.location_name || topCompany}`, type: 'Fire Sprinkler', scope, created_by: createdBy,
  });

  const tx = db.transaction(() => {
    for (const r of rows) {
      // proposed_usd is a ServiceTrade projection, not a cost, so lines start unpriced for the estimator.
      addLine(quote.id, { name: r.description || 'Repair item', unit: 'ea', qty: 1, cost: 0, hrs: 0 });
    }
    db.prepare(`UPDATE est_quotes SET source_deficiencies = ? WHERE id = ?`).run(JSON.stringify(clean), quote.id);
    db.prepare(`UPDATE deficiencies SET quoted = 1 WHERE id IN (${clean.map(() => '?').join(',')})`).run(...clean);
  });
  tx();
  return getQuote(quote.id);
}
