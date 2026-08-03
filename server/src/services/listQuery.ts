import { getDb } from '../db/index';

/**
 * The shared server-side list contract (v2 P0). One query builder every list screen uses so a
 * table of thousands is searched / filtered / sorted / paginated in the database, not by
 * shipping everything to the browser.
 *
 * Safety: table name, searchable columns, filter fragments and sort columns all come from the
 * SPEC (developer-authored, a fixed allow-list). Only the search term is user input, and it is
 * always parameterized. Filter/sort selections are looked up in the spec's maps, never
 * interpolated — so there is no SQL-injection surface from query params.
 */

export interface ListSpec {
  table: string;
  /** always-applied WHERE fragment, e.g. "source = 'servicetrade'" */
  baseWhere?: string;
  /** columns matched (LIKE) against the free-text q */
  searchCols?: string[];
  /** filter key -> WHERE fragment (allow-list) */
  filters?: Record<string, string>;
  /** sort key -> column expression (allow-list) */
  sorts?: Record<string, string>;
  /** default ORDER BY, e.g. "name ASC" */
  defaultSort: string;
}

export interface ListParams {
  q?: string;
  filter?: string;
  sort?: string;
  order?: string;
  page?: number | string;
  pageSize?: number | string;
}

export interface ListResult<T = any> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

export function runList<T = any>(spec: ListSpec, params: ListParams): ListResult<T> {
  const db = getDb();
  const where: string[] = [];
  const args: unknown[] = [];

  if (spec.baseWhere) where.push(spec.baseWhere);

  const filterFrag = params.filter && spec.filters ? spec.filters[params.filter] : undefined;
  if (filterFrag) where.push(filterFrag);

  const q = (params.q || '').trim();
  if (q && spec.searchCols && spec.searchCols.length) {
    const like = `%${q}%`;
    where.push('(' + spec.searchCols.map((c) => `${c} LIKE ?`).join(' OR ') + ')');
    for (let i = 0; i < spec.searchCols.length; i++) args.push(like);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${spec.table} ${whereSql}`).get(...args) as { c: number }).c;

  const sortCol = params.sort && spec.sorts ? spec.sorts[params.sort] : undefined;
  let orderSql = spec.defaultSort;
  if (sortCol) orderSql = `${sortCol} ${String(params.order).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;

  const pageSize = clampInt(params.pageSize, 50, 1, 200);
  const page = clampInt(params.page, 1, 1, 1_000_000);
  const offset = (page - 1) * pageSize;

  const rows = db
    .prepare(`SELECT * FROM ${spec.table} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, offset) as T[];

  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Count rows for a single filter (used to render filter-chip counts). */
export function countWith(spec: ListSpec, filterKey?: string): number {
  const db = getDb();
  const where: string[] = [];
  if (spec.baseWhere) where.push(spec.baseWhere);
  const frag = filterKey && spec.filters ? spec.filters[filterKey] : undefined;
  if (frag) where.push(frag);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${spec.table} ${whereSql}`).get() as { c: number }).c;
}
