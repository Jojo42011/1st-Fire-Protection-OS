import { getDb } from '../db/index';
import { canonicalOffice } from '../os/office';
import starter from './priceBookStarter';

/**
 * The estimating price book (Phase 0). A vendor cost catalog scoped per office, plus each office's
 * margin settings (labor rate, design rate, material markup, overhead, profit). office='' holds the
 * shared starter catalog; an office sees the shared rows plus any of its own overrides (its own SKU
 * wins). Costs are vendor dollars per unit (pipe is per 100 ft). Nothing here is ServiceTrade-synced.
 */

export interface PriceItem {
  id: number; office: string; cat: string | null; sku: string | null; name: string | null;
  unit: string | null; cost: number | null; labor_hrs: number | null; active: number; updated_at: string;
}
export interface Margins { office: string; labor_rate: number; design_rate: number; mat_markup: number; overhead: number; profit: number; }

const DEFAULT_MARGINS: Omit<Margins, 'office'> = { labor_rate: 85, design_rate: 95, mat_markup: 25, overhead: 15, profit: 12 };
const off = (raw: string | null | undefined): string => (raw ? canonicalOffice(raw) || '' : '');

/* ─────────────────────────── margins ─────────────────────────── */

/** The margins for an office, falling back to the shared '' row, then to the built-in defaults. */
export function getMargins(office: string): Margins {
  const db = getDb();
  const key = off(office);
  const row = (db.prepare(`SELECT * FROM est_margins WHERE office = ?`).get(key) as Margins | undefined)
    || (key ? (db.prepare(`SELECT * FROM est_margins WHERE office = ''`).get() as Margins | undefined) : undefined);
  return { office: key, labor_rate: row?.labor_rate ?? DEFAULT_MARGINS.labor_rate, design_rate: row?.design_rate ?? DEFAULT_MARGINS.design_rate,
    mat_markup: row?.mat_markup ?? DEFAULT_MARGINS.mat_markup, overhead: row?.overhead ?? DEFAULT_MARGINS.overhead, profit: row?.profit ?? DEFAULT_MARGINS.profit };
}

export function setMargins(office: string, patch: Partial<Omit<Margins, 'office'>>): Margins {
  const db = getDb();
  const key = off(office);
  const cur = getMargins(key);
  const next = { ...cur, ...patch, office: key };
  db.prepare(`INSERT INTO est_margins (office, labor_rate, design_rate, mat_markup, overhead, profit, updated_at)
    VALUES (@office,@labor_rate,@design_rate,@mat_markup,@overhead,@profit, datetime('now'))
    ON CONFLICT(office) DO UPDATE SET labor_rate=@labor_rate, design_rate=@design_rate, mat_markup=@mat_markup,
      overhead=@overhead, profit=@profit, updated_at=datetime('now')`).run(next as any);
  return getMargins(key);
}

/** Build-up sell price from material cost + labor/design hours, using an office's margins. This is the
 *  Lubbock formula: mark up material, add labor, add overhead, add profit. */
export function sellPrice(matCost: number, laborHrs: number, designHrs: number, m: Margins): number {
  const labor = laborHrs * m.labor_rate + designHrs * m.design_rate;
  const marked = matCost * (1 + m.mat_markup / 100);
  const direct = marked + labor;
  const withOh = direct * (1 + m.overhead / 100);
  return Math.round(withOh * (1 + m.profit / 100));
}

/* ─────────────────────────── catalog ─────────────────────────── */

/** The catalog an office estimates from: the office's own rows plus the shared '' rows it hasn't
 *  overridden (same SKU). Optional text search across sku/name/cat. */
export function listPriceBook(office: string, q = '', limit = 500): { items: PriceItem[]; total: number } {
  const db = getDb();
  const key = off(office);
  const rows = db.prepare(`SELECT * FROM price_book WHERE active = 1 AND office IN ('', ?)`).all(key) as PriceItem[];
  const bySku = new Map<string, PriceItem>();
  for (const r of rows) { const k = String(r.sku || r.id); const prev = bySku.get(k); if (!prev || (r.office === key && prev.office !== key)) bySku.set(k, r); }
  let items = [...bySku.values()];
  const term = q.trim().toLowerCase();
  if (term) items = items.filter((r) => `${r.sku} ${r.name} ${r.cat}`.toLowerCase().includes(term));
  items.sort((a, b) => `${a.cat}`.localeCompare(`${b.cat}`) || `${a.name}`.localeCompare(`${b.name}`));
  const total = items.length;
  return { items: items.slice(0, limit), total };
}

export function getItemBySku(office: string, sku: string): PriceItem | null {
  const db = getDb();
  const key = off(office);
  return (db.prepare(`SELECT * FROM price_book WHERE sku = ? AND office = ? AND active = 1`).get(sku, key) as PriceItem | undefined)
    || (db.prepare(`SELECT * FROM price_book WHERE sku = ? AND office = '' AND active = 1`).get(sku) as PriceItem | undefined)
    || null;
}

export function upsertItem(office: string, it: { sku: string; name?: string; cat?: string; unit?: string; cost?: number; labor_hrs?: number }): PriceItem | null {
  const sku = String(it.sku || '').trim();
  if (!sku) return null;
  const db = getDb();
  const key = off(office);
  db.prepare(`INSERT INTO price_book (office, cat, sku, name, unit, cost, labor_hrs, updated_at)
    VALUES (?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(office, sku) DO UPDATE SET cat=excluded.cat, name=excluded.name, unit=excluded.unit,
      cost=excluded.cost, labor_hrs=excluded.labor_hrs, active=1, updated_at=datetime('now')`)
    .run(key, it.cat || null, sku, it.name || null, it.unit || null, it.cost ?? null, it.labor_hrs ?? 0);
  return db.prepare(`SELECT * FROM price_book WHERE office = ? AND sku = ?`).get(key, sku) as PriceItem;
}

export function deleteItem(id: number): boolean {
  return getDb().prepare(`UPDATE price_book SET active = 0 WHERE id = ?`).run(id).changes > 0;
}

/** Load the 2,000+ line starter vendor catalog into the shared ('') catalog. Idempotent. */
export function seedStarterCatalog(): { inserted: number } {
  const db = getDb();
  const have = (db.prepare(`SELECT COUNT(*) c FROM price_book WHERE office = ''`).get() as { c: number }).c;
  if (have > 0) return { inserted: 0 };
  const ins = db.prepare(`INSERT OR IGNORE INTO price_book (office, cat, sku, name, unit, cost, labor_hrs) VALUES ('',?,?,?,?,?,?)`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const it of starter as any[]) { if (!it.sku) continue; ins.run(it.cat || null, String(it.sku), it.name || null, it.unit || null, Number(it.cost) || 0, Number(it.labor_hrs) || 0); n++; }
  });
  tx();
  return { inserted: n };
}

/* ─────────────────────────── CSV import ─────────────────────────── */

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const parse = (line: string): string[] => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) { const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
    out.push(cur); return out.map((s) => s.trim());
  };
  return { headers: parse(lines[0]).map((h) => h.toLowerCase()), rows: lines.slice(1).map(parse) };
}
const num = (s: string) => { const m = String(s || '').replace(/[^0-9.\-]/g, ''); const n = parseFloat(m); return Number.isFinite(n) ? n : 0; };

/** Import a vendor price CSV into one office's catalog. Recognizes sku, name, cat, unit, cost/price,
 *  labor_hrs/hrs columns in any order. Preview when commit is false. */
export function importPriceBookCsv(office: string, csv: string, commit: boolean): { ok: boolean; error?: string; total: number; imported: number; sample: any[] } {
  const { headers, rows } = parseCsv(csv);
  if (!rows.length) return { ok: false, error: 'No data rows found.', total: 0, imported: 0, sample: [] };
  const col = (...aliases: string[]) => { for (const a of aliases) { const i = headers.indexOf(a); if (i >= 0) return i; } return -1; };
  const cSku = col('sku', 'item', 'part', 'part number', 'part #', 'number');
  const cName = col('name', 'description', 'desc', 'item name');
  const cCat = col('cat', 'category', 'class', 'group');
  const cUnit = col('unit', 'uom', 'per');
  const cCost = col('cost', 'price', 'unit cost', 'unit price', 'each');
  const cHrs = col('labor_hrs', 'hrs', 'hours', 'labor', 'install hrs');
  if (cSku < 0) return { ok: false, error: 'Need a SKU / part-number column.', total: rows.length, imported: 0, sample: [] };
  const items = rows.map((r) => ({
    sku: String(r[cSku] || '').trim(), name: cName >= 0 ? r[cName] : '', cat: cCat >= 0 ? r[cCat] : '',
    unit: cUnit >= 0 ? r[cUnit] : '', cost: cCost >= 0 ? num(r[cCost]) : 0, labor_hrs: cHrs >= 0 ? num(r[cHrs]) : 0,
  })).filter((it) => it.sku);
  let imported = 0;
  if (commit) { const tx = getDb().transaction(() => { for (const it of items) { upsertItem(office, it); imported++; } }); tx(); }
  return { ok: true, total: items.length, imported, sample: items.slice(0, 25) };
}
