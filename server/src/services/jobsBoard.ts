import { getDb } from '../db/index';
import { canonicalOffice } from '../os/office';
import { getQuote } from './quotesBuilder';

/**
 * Phase 4: the project board. A won quote becomes an est_jobs row, and the board tracks it through the
 * field lifecycle as a kanban keyed on `stage`. Local and mutable (like est_quotes), separate from the
 * read-only ServiceTrade crm_jobs mirror. jobFromQuote is idempotent per quote (unique index on
 * quote_id), so re-marking a quote won never spawns a duplicate job.
 */

export interface Job {
  id: number; number: string | null; quote_id: number | null; office: string; account_id: number | null;
  customer: string | null; address: string | null; contact: string | null; title: string | null; type: string;
  contract_value: number; stage: string; pm: string | null; start_date: string | null; due_date: string | null;
  notes: string | null; outcome_note: string | null; created_by: string | null; created_at: string; updated_at: string;
}

/** The board columns, in field order. `terminal` stages sit at the end of the pipeline. */
export const STAGES: { key: string; label: string; terminal?: boolean }[] = [
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'punch', label: 'Punch / inspection' },
  { key: 'complete', label: 'Complete', terminal: true },
  { key: 'invoiced', label: 'Invoiced', terminal: true },
  { key: 'on_hold', label: 'On hold' },
];
const STAGE_KEYS = STAGES.map((s) => s.key);

const off = (raw: string | null | undefined): string => (raw ? canonicalOffice(raw) || '' : '');

function nextNumber(): string {
  const row = getDb().prepare(`SELECT number FROM est_jobs WHERE number LIKE 'JOB-%' ORDER BY id DESC LIMIT 1`).get() as { number: string } | undefined;
  const last = row ? parseInt(String(row.number).replace(/\D/g, ''), 10) || 2000 : 2000;
  return `JOB-${last + 1}`;
}

export function getJob(id: number): Job | null {
  return (getDb().prepare(`SELECT * FROM est_jobs WHERE id = ?`).get(id) as Job) || null;
}

/** The job spawned from a given quote, if any (so the quote screen can link to it). */
export function jobForQuote(quoteId: number): Job | null {
  return (getDb().prepare(`SELECT * FROM est_jobs WHERE quote_id = ?`).get(quoteId) as Job) || null;
}

/**
 * Create the field job for a won quote. Idempotent: if a job already exists for the quote it is
 * returned unchanged. Pulls customer, office, value and scope straight off the quote.
 */
export function jobFromQuote(quoteId: number, createdBy?: string): Job | null {
  const existing = jobForQuote(quoteId);
  if (existing) return existing;
  const d = getQuote(quoteId);
  if (!d) return null;
  const q = d.quote;
  const info = getDb().prepare(
    `INSERT INTO est_jobs (number, quote_id, office, account_id, customer, address, contact, title, type, contract_value, stage, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`
  ).run(
    nextNumber(), quoteId, q.office || '', q.account_id ?? null, q.customer || null, q.address || null, q.contact || null,
    q.title || `Job for ${q.number || 'quote'}`, q.type || 'Fire Sprinkler', Number(d.totals.sellPrice) || 0,
    q.scope || null, createdBy || q.created_by || null,
  );
  return getJob(Number(info.lastInsertRowid));
}

/** Create a standalone job not tied to a quote. */
export function createJob(input: Partial<Job> & { created_by?: string }): Job {
  const info = getDb().prepare(
    `INSERT INTO est_jobs (number, office, account_id, customer, address, contact, title, type, contract_value, stage, pm, start_date, due_date, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nextNumber(), off(input.office), input.account_id ?? null, input.customer || null, input.address || null, input.contact || null,
    input.title || 'New job', input.type || 'Fire Sprinkler', Number(input.contract_value) || 0,
    STAGE_KEYS.includes(String(input.stage)) ? input.stage : 'scheduled',
    input.pm || null, input.start_date || null, input.due_date || null, input.notes || null, input.created_by || null,
  );
  return getJob(Number(info.lastInsertRowid))!;
}

const FIELDS: (keyof Job)[] = ['customer', 'address', 'contact', 'title', 'type', 'contract_value', 'pm', 'start_date', 'due_date', 'notes', 'account_id', 'office'];

export function updateJob(id: number, patch: Record<string, any>): Job | null {
  if (!getJob(id)) return null;
  const sets: string[] = []; const args: any[] = [];
  for (const f of FIELDS) {
    if (patch[f] === undefined) continue;
    let v: any = patch[f];
    if (f === 'contract_value') v = Number(v) || 0;
    if (f === 'office') v = off(v);
    if (f === 'account_id') v = v === null || v === '' ? null : Number(v);
    sets.push(`${f} = ?`); args.push(v);
  }
  if (!sets.length) return getJob(id);
  args.push(id);
  getDb().prepare(`UPDATE est_jobs SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...args);
  return getJob(id);
}

export function setStage(id: number, stage: string, note?: string): Job | null {
  if (!STAGE_KEYS.includes(stage)) return null;
  if (!getJob(id)) return null;
  if (note !== undefined) getDb().prepare(`UPDATE est_jobs SET stage = ?, outcome_note = ?, updated_at = datetime('now') WHERE id = ?`).run(stage, note || null, id);
  else getDb().prepare(`UPDATE est_jobs SET stage = ?, updated_at = datetime('now') WHERE id = ?`).run(stage, id);
  return getJob(id);
}

export function deleteJob(id: number): boolean {
  return getDb().prepare(`DELETE FROM est_jobs WHERE id = ?`).run(id).changes > 0;
}

/** List jobs. officeKeys restricts to the caller's authorized offices (null = company-wide, [] = none). */
export function listJobs(officeKeys: string[] | null = null, stage = ''): Job[] {
  const where: string[] = []; const args: any[] = [];
  if (officeKeys !== null) {
    if (!officeKeys.length) return [];
    where.push(`os_office_key(office) IN (${officeKeys.map(() => '?').join(',')})`);
    args.push(...officeKeys);
  }
  if (stage && STAGE_KEYS.includes(stage)) { where.push('stage = ?'); args.push(stage); }
  const sql = `SELECT * FROM est_jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 500`;
  return getDb().prepare(sql).all(...args) as Job[];
}

/** Jobs grouped into board columns plus per-stage count and open pipeline value. */
export function board(officeKeys: string[] | null = null): { stages: typeof STAGES; columns: Record<string, Job[]>; summary: { open: number; value: number } } {
  const jobs = listJobs(officeKeys);
  const columns: Record<string, Job[]> = {};
  for (const s of STAGES) columns[s.key] = [];
  for (const j of jobs) (columns[j.stage] || (columns[j.stage] = [])).push(j);
  // "Open" pipeline = everything not yet invoiced.
  const open = jobs.filter((j) => j.stage !== 'invoiced');
  const value = open.reduce((s, j) => s + (Number(j.contract_value) || 0), 0);
  return { stages: STAGES, columns, summary: { open: open.length, value } };
}
