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

export { resolvePeriod };
export function labelForOffice(key: string): string { return officeLabel(key); }
