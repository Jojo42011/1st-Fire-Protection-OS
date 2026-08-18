/**
 * The central metrics layer.
 *
 * Every KPI in the OS is defined here ONCE, with one authoritative definition, its source system,
 * the office column it scopes on (or null for company-wide), and the date column it flows over (or
 * null for a point-in-time snapshot). No screen recomputes revenue/AR/win-rate its own way — they
 * all call runMetric()/metricByOffice(), so a number means the same thing everywhere. Office scope
 * is enforced in SQL via officeScopeClause(); date scope via the metric's own date column.
 *
 * Financial truth (revenue, GP, operating income) lands when Sage Intacct is mirrored (Phase 6);
 * until then only metrics the ServiceTrade mirror can honestly support are defined, each labeled
 * with its source so the UI never implies GL-grade truth it does not have.
 */
import { getDb } from '../db/index';
import { OsContext, resolveOffice, officeScopeClause, allowedOffices } from './scope';
import { officeLabel } from './office';
import { DateRange, resolvePeriod } from './period';

export type Unit = 'usd' | 'count' | 'percent';

const AVG_REPAIR_USD = 650; // matches deficiencySync; only ever surfaced as "projected"
const OPEN_DEF = `lower(status) NOT IN ('fixed','invalid','canceled','cancelled','deleted','closed')`;
const WON = `lower(stage) IN ('accepted','approved','won')`;
const LOST = `lower(stage) IN ('rejected','lost','canceled','cancelled','expired','void')`;
const OPEN_Q = `lower(stage) IN ('draft','submitted','pending','reviewed','contingent')`;

interface MetricDef {
  key: string;
  label: string;
  unit: Unit;
  source: string;                 // provenance shown in the UI
  from?: string;                  // table
  expr?: string;                  // aggregate expression producing `v`
  base?: string;                  // extra WHERE (no scope/date)
  officeColumn: string | null;    // null = company-wide (table has no office column yet)
  dateColumn: string | null;      // null = point-in-time snapshot (ignores the period)
  derive?: (get: (k: string) => number) => number; // computed from other metrics
}

const M: MetricDef[] = [
  { key: 'open_pipeline', label: 'Open pipeline', unit: 'usd', source: 'ServiceTrade', from: 'quotes',
    expr: 'COALESCE(SUM(amount_cents),0)/100.0', base: `source='servicetrade' AND ${OPEN_Q}`, officeColumn: 'office', dateColumn: null },
  { key: 'quotes_won', label: 'Quotes won', unit: 'count', source: 'ServiceTrade', from: 'quotes',
    expr: 'COUNT(*)', base: `source='servicetrade' AND ${WON}`, officeColumn: 'office', dateColumn: null },
  { key: 'quotes_lost', label: 'Quotes lost', unit: 'count', source: 'ServiceTrade', from: 'quotes',
    expr: 'COUNT(*)', base: `source='servicetrade' AND ${LOST}`, officeColumn: 'office', dateColumn: null },
  { key: 'quote_win_rate', label: 'Quote win rate', unit: 'percent', source: 'ServiceTrade', officeColumn: 'office', dateColumn: null,
    derive: (g) => { const w = g('quotes_won'), l = g('quotes_lost'); return w + l > 0 ? Math.round((w / (w + l)) * 100) : 0; } },
  { key: 'open_deficiencies', label: 'Open deficiencies', unit: 'count', source: 'ServiceTrade', from: 'deficiencies',
    expr: 'COUNT(*)', base: OPEN_DEF, officeColumn: 'office', dateColumn: null },
  { key: 'unquoted_deficiencies', label: 'Unquoted deficiencies', unit: 'count', source: 'ServiceTrade', from: 'deficiencies',
    expr: 'COUNT(*)', base: `${OPEN_DEF} AND COALESCE(quoted,0)=0`, officeColumn: 'office', dateColumn: null },
  { key: 'quoted_deficiencies', label: 'Quoted deficiencies', unit: 'count', source: 'ServiceTrade', from: 'deficiencies',
    expr: 'COUNT(*)', base: `${OPEN_DEF} AND COALESCE(quoted,0)=1`, officeColumn: 'office', dateColumn: null },
  { key: 'quoted_repair_value', label: 'Quoted repair value', unit: 'usd', source: 'ServiceTrade', from: 'deficiencies',
    expr: 'COALESCE(SUM(proposed_usd),0)', base: OPEN_DEF, officeColumn: 'office', dateColumn: null },
  { key: 'projected_repair_opportunity', label: 'Projected repair opportunity', unit: 'usd', source: 'Derived (projection)', officeColumn: 'office', dateColumn: null,
    derive: (g) => g('unquoted_deficiencies') * AVG_REPAIR_USD },
  { key: 'repair_opportunity_total', label: 'Repair opportunity', unit: 'usd', source: 'ServiceTrade + projection', officeColumn: 'office', dateColumn: null,
    derive: (g) => g('quoted_repair_value') + g('projected_repair_opportunity') },
  { key: 'deficiency_quote_rate', label: 'Deficiency quote rate', unit: 'percent', source: 'ServiceTrade', officeColumn: 'office', dateColumn: null,
    derive: (g) => { const o = g('open_deficiencies'); return o > 0 ? Math.round((g('quoted_deficiencies') / o) * 100) : 0; } },
  { key: 'jobs_completed', label: 'Jobs completed', unit: 'count', source: 'ServiceTrade', from: 'crm_jobs',
    expr: 'COUNT(*)', base: `source='servicetrade' AND completed_at IS NOT NULL`, officeColumn: 'office_name', dateColumn: 'completed_at' },
  { key: 'jobs_total', label: 'Jobs', unit: 'count', source: 'ServiceTrade', from: 'crm_jobs',
    expr: 'COUNT(*)', base: `source='servicetrade'`, officeColumn: 'office_name', dateColumn: null },
  { key: 'service_agreements', label: 'Service agreements', unit: 'count', source: 'ServiceTrade', from: 'service_recurrences',
    expr: 'COUNT(*)', base: '1=1', officeColumn: 'office', dateColumn: null },
  // Company-wide (the invoices fixture has no office column yet): honest, never silently mis-scoped.
  { key: 'ar_outstanding', label: 'Accounts receivable', unit: 'usd', source: 'Invoices', from: 'invoices',
    expr: 'COALESCE(SUM(amount),0)', base: `status != 'paid'`, officeColumn: null, dateColumn: null },
  { key: 'ar_90_plus', label: 'AR over 90 days', unit: 'usd', source: 'Invoices', from: 'invoices',
    expr: 'COALESCE(SUM(amount),0)', base: `status != 'paid' AND due_at IS NOT NULL AND julianday('now') - julianday(due_at) > 90`, officeColumn: null, dateColumn: null },
];

const REGISTRY: Record<string, MetricDef> = Object.fromEntries(M.map((d) => [d.key, d]));

/** Semantic direction: does a HIGHER value read as good or bad? Drives KPI tone (never color alone). */
const DIRECTION: Record<string, 'up_good' | 'up_bad'> = {
  open_pipeline: 'up_good', quotes_won: 'up_good', quote_win_rate: 'up_good',
  quoted_repair_value: 'up_good', repair_opportunity_total: 'up_good', projected_repair_opportunity: 'up_good',
  deficiency_quote_rate: 'up_good', jobs_completed: 'up_good', jobs_total: 'up_good', service_agreements: 'up_good',
  quotes_lost: 'up_bad', open_deficiencies: 'up_bad', unquoted_deficiencies: 'up_bad', quoted_deficiencies: 'up_bad',
  ar_outstanding: 'up_bad', ar_90_plus: 'up_bad',
};

/** Drill-down record definitions: the underlying rows behind a metric. Reuses the metric's own
 *  from/base/officeColumn/dateColumn so the records match the number EXACTLY, scoped in SQL. */
interface DrillCol { sql: string; as: string; label: string; kind?: 'money' | 'date' | 'text' | 'num' }
const DRILL: Record<string, { columns: DrillCol[]; orderBy: string }> = {
  open_pipeline: { columns: [
    { sql: 'number', as: 'number', label: 'Quote #', kind: 'text' },
    { sql: 'title', as: 'title', label: 'Title', kind: 'text' },
    { sql: 'office', as: 'office', label: 'Office', kind: 'text' },
    { sql: 'stage', as: 'stage', label: 'Stage', kind: 'text' },
    { sql: 'sent_at', as: 'sent_at', label: 'Sent', kind: 'date' },
    { sql: 'amount_cents/100.0', as: 'amount', label: 'Value', kind: 'money' },
  ], orderBy: 'amount_cents DESC' },
  open_deficiencies: { columns: defCols(), orderBy: 'proposed_usd DESC, reported_at ASC' },
  unquoted_deficiencies: { columns: defCols(), orderBy: 'reported_at ASC' },
  quoted_deficiencies: { columns: defCols(), orderBy: 'proposed_usd DESC' },
  quoted_repair_value: { columns: defCols(), orderBy: 'proposed_usd DESC' },
  jobs_completed: { columns: jobCols(), orderBy: 'completed_at DESC' },
  jobs_total: { columns: jobCols(), orderBy: 'COALESCE(completed_at, scheduled_at) DESC' },
  service_agreements: { columns: [
    { sql: 'location_name', as: 'site', label: 'Site', kind: 'text' },
    { sql: 'office', as: 'office', label: 'Office', kind: 'text' },
    { sql: 'frequency', as: 'frequency', label: 'Frequency', kind: 'text' },
    { sql: 'ends_on', as: 'ends_on', label: 'Ends', kind: 'date' },
  ], orderBy: 'ends_on ASC' },
  ar_outstanding: { columns: arCols(), orderBy: 'amount DESC' },
  ar_90_plus: { columns: arCols(), orderBy: 'due_at ASC' },
  quotes_won: { columns: quoteCols(), orderBy: 'amount_cents DESC' },
  quotes_lost: { columns: quoteCols(), orderBy: 'amount_cents DESC' },
};
function defCols(): DrillCol[] {
  return [
    { sql: 'company_name', as: 'customer', label: 'Site / customer', kind: 'text' },
    { sql: 'location_name', as: 'location', label: 'Location', kind: 'text' },
    { sql: 'description', as: 'description', label: 'Deficiency', kind: 'text' },
    { sql: 'office', as: 'office', label: 'Office', kind: 'text' },
    { sql: 'status', as: 'status', label: 'Status', kind: 'text' },
    { sql: 'reported_at', as: 'reported_at', label: 'Reported', kind: 'date' },
    { sql: 'proposed_usd', as: 'value', label: 'Quoted $', kind: 'money' },
  ];
}
function jobCols(): DrillCol[] {
  return [
    { sql: 'number', as: 'number', label: 'Job #', kind: 'text' },
    { sql: 'kind', as: 'kind', label: 'Type', kind: 'text' },
    { sql: 'office_name', as: 'office', label: 'Office', kind: 'text' },
    { sql: 'status', as: 'status', label: 'Status', kind: 'text' },
    { sql: 'completed_at', as: 'completed_at', label: 'Completed', kind: 'date' },
  ];
}
function arCols(): DrillCol[] {
  return [
    { sql: 'customer', as: 'customer', label: 'Customer', kind: 'text' },
    { sql: 'due_at', as: 'due_at', label: 'Due', kind: 'date' },
    { sql: 'status', as: 'status', label: 'Status', kind: 'text' },
    { sql: 'amount', as: 'amount', label: 'Amount', kind: 'money' },
  ];
}
function quoteCols(): DrillCol[] {
  return [
    { sql: 'number', as: 'number', label: 'Quote #', kind: 'text' },
    { sql: 'title', as: 'title', label: 'Title', kind: 'text' },
    { sql: 'office', as: 'office', label: 'Office', kind: 'text' },
    { sql: 'stage', as: 'stage', label: 'Stage', kind: 'text' },
    { sql: 'amount_cents/100.0', as: 'amount', label: 'Value', kind: 'money' },
  ];
}

export function metricKeys(): string[] { return M.map((d) => d.key); }
export function metricCatalog(): Array<{ key: string; label: string; unit: Unit; source: string; officeScoped: boolean; dateScoped: boolean }> {
  return M.map((d) => ({ key: d.key, label: d.label, unit: d.unit, source: d.source, officeScoped: d.officeColumn != null, dateScoped: d.dateColumn != null }));
}

export interface MetricResult {
  key: string; label: string; unit: Unit; source: string;
  value: number;
  officeScoped: boolean;
  dateScoped: boolean;
  companyWide: boolean; // true when the metric could not be office-scoped (no office column)
  office: string;       // resolved office key or 'all'/'__scoped__'
}

/** Compute one metric for the caller's scope. Returns null on an unknown key; throws nothing. */
export function runMetric(key: string, ctx: OsContext, opts: { office?: string; range?: DateRange } = {}): MetricResult | { error: string; status: number } {
  const def = REGISTRY[key];
  if (!def) return { error: 'unknown_metric', status: 404 };

  const resolved = resolveOffice(ctx, opts.office);
  if ('error' in resolved) return resolved;
  const office = resolved.office;

  let value: number;
  if (def.derive) {
    value = def.derive((k) => {
      const r = runMetric(k, ctx, opts);
      return 'error' in r ? 0 : r.value;
    });
  } else {
    value = rawValue(def, ctx, office, opts.range || null);
  }

  return {
    key: def.key, label: def.label, unit: def.unit, source: def.source,
    value,
    officeScoped: def.officeColumn != null,
    dateScoped: def.dateColumn != null,
    companyWide: def.officeColumn == null,
    office,
  };
}

function rawValue(def: MetricDef, ctx: OsContext, office: string, range: DateRange | null): number {
  const db = getDb();
  const parts: string[] = [def.base || '1=1'];
  const params: any[] = [];

  if (def.officeColumn) {
    const scope = officeScopeClause(def.officeColumn, ctx, office);
    parts.push(scope.sql);
    params.push(...scope.params);
  }
  if (def.dateColumn && range && (range.start || range.end)) {
    if (range.start) { parts.push(`date(${def.dateColumn}) >= date(?)`); params.push(range.start); }
    if (range.end) { parts.push(`date(${def.dateColumn}) < date(?)`); params.push(range.end); }
  }
  const sql = `SELECT ${def.expr} AS v FROM ${def.from} WHERE ${parts.join(' AND ')}`;
  try {
    return (db.prepare(sql).get(...params) as { v: number }).v || 0;
  } catch {
    return 0;
  }
}

/** Compute a metric grouped by office, restricted to the caller's authorized offices (for comparison). */
export function metricByOffice(key: string, ctx: OsContext, opts: { range?: DateRange } = {}): Array<{ office: string; label: string; value: number }> {
  const def = REGISTRY[key];
  if (!def) return [];
  const offices = allowedOffices(ctx); // already scope-limited
  return offices.map((o) => {
    const r = runMetric(key, ctx, { office: o.key, range: opts.range });
    return { office: o.key, label: o.label, value: 'error' in r ? 0 : r.value };
  });
}

/* ─────────────────────────── KPI card contract (comparison + tone + format) ─────────────────────────── */

export interface MetricCard extends MetricResult {
  format: 'usd' | 'count' | 'percent';
  direction: 'up_good' | 'up_bad' | 'neutral';
  projected: boolean;
  drillable: boolean;
  comparison: null | {
    previous: number;
    changeAbs: number;
    changePct: number | null; // null when previous is 0 (no defensible %)
    periodLabel: string;
    tone: 'good' | 'bad' | 'neutral';
  };
}

/** The full KPI card contract for a metric: value + format + tone + comparison-vs-previous-period.
 *  Comparison is ONLY computed for date-scoped (flow) metrics, where a prior equal-length period is a
 *  defensible comparison. Point-in-time metrics (AR balance, open pipeline) return comparison:null
 *  rather than fabricating history. */
export function metricCard(key: string, ctx: OsContext, opts: { office?: string; range?: DateRange; compare?: boolean } = {}): MetricCard | { error: string; status: number } {
  const cur = runMetric(key, ctx, { office: opts.office, range: opts.range });
  if ('error' in cur) return cur;
  const def = REGISTRY[key];
  const direction = DIRECTION[key] || 'neutral';
  const projected = /projection|projected/i.test(def.source) || key === 'repair_opportunity_total';

  let comparison: MetricCard['comparison'] = null;
  if (opts.compare && def.dateColumn && opts.range && opts.range.start) {
    const prevRange = previousRange(opts.range);
    if (prevRange) {
      const prev = runMetric(key, ctx, { office: opts.office, range: prevRange });
      if (!('error' in prev)) {
        const changeAbs = cur.value - prev.value;
        const changePct = prev.value !== 0 ? Math.round((changeAbs / Math.abs(prev.value)) * 100) : null;
        const improving = direction === 'up_bad' ? changeAbs < 0 : changeAbs > 0;
        const tone: 'good' | 'bad' | 'neutral' = changeAbs === 0 ? 'neutral' : improving ? 'good' : 'bad';
        comparison = { previous: prev.value, changeAbs, changePct, periodLabel: prevRange.label, tone };
      }
    }
  }

  return { ...cur, format: cur.unit, direction, projected, drillable: !!DRILL[key], comparison };
}

/** The prior equal-length calendar range immediately before `range` (for period-over-period). */
function previousRange(range: DateRange): DateRange | null {
  if (!range.start || !range.end) return null;
  const start = new Date(range.start + 'T00:00:00Z').getTime();
  const end = new Date(range.end + 'T00:00:00Z').getTime();
  const span = end - start;
  if (!(span > 0)) return null;
  const prevStart = new Date(start - span).toISOString().slice(0, 10);
  const prevEnd = range.start;
  return { key: 'custom', start: prevStart, end: prevEnd, label: 'prior period' };
}

/* ─────────────────────────── trend (real series from dated records) ─────────────────────────── */

/** An ordered monthly time series for a date-scoped metric, from the underlying dated records.
 *  Point-in-time metrics (no dateColumn) are NOT trendable without historical snapshots we don't
 *  keep — they return { supported:false } rather than fabricating history. Office-scoped in SQL. */
export function metricTrend(key: string, ctx: OsContext, opts: { office?: string; range?: DateRange } = {}): { supported: boolean; points: Array<{ bucket: string; value: number }>; reason?: string } {
  const def = REGISTRY[key];
  if (!def) return { supported: false, points: [], reason: 'unknown_metric' };
  if (!def.from || !def.dateColumn) return { supported: false, points: [], reason: 'point_in_time' };
  const resolved = resolveOffice(ctx, opts.office);
  if ('error' in resolved) return { supported: false, points: [], reason: resolved.error };

  const db = getDb();
  const parts: string[] = [def.base || '1=1'];
  const params: any[] = [];
  if (def.officeColumn) {
    const scope = officeScopeClause(def.officeColumn, ctx, resolved.office);
    parts.push(scope.sql); params.push(...scope.params);
  }
  const range = opts.range;
  if (range && range.start) { parts.push(`date(${def.dateColumn}) >= date(?)`); params.push(range.start); }
  if (range && range.end) { parts.push(`date(${def.dateColumn}) < date(?)`); params.push(range.end); }
  // aggregate is the metric's own expression, bucketed by month
  const sql = `SELECT strftime('%Y-%m', ${def.dateColumn}) AS bucket, ${def.expr} AS v
               FROM ${def.from} WHERE ${parts.join(' AND ')} AND ${def.dateColumn} IS NOT NULL
               GROUP BY bucket ORDER BY bucket ASC`;
  try {
    const rows = db.prepare(sql).all(...params) as { bucket: string; v: number }[];
    return { supported: true, points: rows.map((r) => ({ bucket: r.bucket, value: r.v || 0 })) };
  } catch {
    return { supported: false, points: [], reason: 'query_failed' };
  }
}

/* ─────────────────────────── generic drill-down (records behind a metric) ─────────────────────────── */

export interface DrillResult {
  key: string; label: string; office: string;
  total: number; limit: number; offset: number;
  columns: Array<{ as: string; label: string; kind: string }>;
  rows: any[];
}

/** The authorized records that compose a metric — the same base/scope/date as the metric itself, so
 *  the row set matches the number exactly. Server- and office-scoped, paginated, sorted. */
export function metricDrill(key: string, ctx: OsContext, opts: { office?: string; range?: DateRange; limit?: number; offset?: number } = {}): DrillResult | { error: string; status: number } {
  const def = REGISTRY[key];
  if (!def) return { error: 'unknown_metric', status: 404 };
  const drill = DRILL[key];
  if (!drill || !def.from) return { error: 'no_drilldown', status: 400 }; // derived/point metrics have no record set

  const resolved = resolveOffice(ctx, opts.office);
  if ('error' in resolved) return resolved;

  const db = getDb();
  const parts: string[] = [def.base || '1=1'];
  const params: any[] = [];
  if (def.officeColumn) {
    const scope = officeScopeClause(def.officeColumn, ctx, resolved.office);
    parts.push(scope.sql); params.push(...scope.params);
  }
  if (def.dateColumn && opts.range) {
    if (opts.range.start) { parts.push(`date(${def.dateColumn}) >= date(?)`); params.push(opts.range.start); }
    if (opts.range.end) { parts.push(`date(${def.dateColumn}) < date(?)`); params.push(opts.range.end); }
  }
  const where = parts.join(' AND ');
  const limit = Math.min(200, Math.max(1, opts.limit || 50));
  const offset = Math.max(0, opts.offset || 0);
  const cols = drill.columns.map((c) => `${c.sql} AS ${c.as}`).join(', ');

  try {
    const total = (db.prepare(`SELECT COUNT(*) v FROM ${def.from} WHERE ${where}`).get(...params) as { v: number }).v || 0;
    const rows = db.prepare(`SELECT ${cols} FROM ${def.from} WHERE ${where} ORDER BY ${drill.orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return {
      key: def.key, label: def.label, office: resolved.office,
      total, limit, offset,
      columns: drill.columns.map((c) => ({ as: c.as, label: c.label, kind: c.kind || 'text' })),
      rows,
    };
  } catch (e) {
    return { error: 'drill_failed', status: 500 };
  }
}

export function hasDrill(key: string): boolean { return !!DRILL[key]; }

export { resolvePeriod };
export function labelForOffice(key: string): string { return officeLabel(key); }
