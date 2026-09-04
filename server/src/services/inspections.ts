import { getDb } from '../db/index';
import { canonicalOffice } from '../os/office';
import { templateFor, checklistFor, ChecklistItem } from './nfpaChecklists';

/**
 * Phase 5: NFPA ITM inspections and AHJ reports. An inspection snapshots the correct NFPA checklist
 * (10 extinguishers / 25 sprinkler / 72 alarm) for the chosen system and service interval into
 * inspection_items. The inspector marks each line pass / fail / n-a. On finalize, every failed line is
 * pushed into the deficiencies backlog (source='inspection') so it flows straight into the quote
 * builder, closing the loop: inspection -> deficiency -> quote -> won -> job.
 */

export interface Inspection {
  id: number; number: string | null; office: string; account_id: number | null; site_id: number | null;
  customer: string | null; address: string | null; contact: string | null;
  system: string | null; code: string | null; interval: string | null; status: string; result: string | null;
  inspector: string | null; inspected_at: string | null; notes: string | null;
  created_by: string | null; created_at: string; updated_at: string;
}
export interface InspectionItem {
  id: number; inspection_id: number; item_key: string | null; text: string | null; freq: string | null; kind: string | null; ref: string | null;
  result: string; note: string | null; deficiency_id: number | null; sort: number;
}
export interface InspectionWithItems { inspection: Inspection; items: InspectionItem[]; summary: { total: number; pass: number; fail: number; na: number; open: number } }

const off = (raw: string | null | undefined): string => (raw ? canonicalOffice(raw) || '' : '');

function nextNumber(): string {
  const row = getDb().prepare(`SELECT number FROM inspections WHERE number LIKE 'INS-%' ORDER BY id DESC LIMIT 1`).get() as { number: string } | undefined;
  const last = row ? parseInt(String(row.number).replace(/\D/g, ''), 10) || 3000 : 3000;
  return `INS-${last + 1}`;
}

export function getInspection(id: number): InspectionWithItems | null {
  const db = getDb();
  const inspection = db.prepare(`SELECT * FROM inspections WHERE id = ?`).get(id) as Inspection | undefined;
  if (!inspection) return null;
  const items = db.prepare(`SELECT * FROM inspection_items WHERE inspection_id = ? ORDER BY sort, id`).all(id) as InspectionItem[];
  const pass = items.filter((i) => i.result === 'pass').length;
  const fail = items.filter((i) => i.result === 'fail').length;
  const na = items.filter((i) => i.result === 'na').length;
  const open = items.filter((i) => !i.result).length;
  return { inspection, items, summary: { total: items.length, pass, fail, na, open } };
}

/** Start an inspection: snapshot the checklist due for this system at this interval into rows. */
export function createInspection(input: {
  office?: string; system: string; interval?: string; account_id?: number | null;
  customer?: string; address?: string; contact?: string; inspector?: string; created_by?: string;
}): InspectionWithItems | null {
  const tpl = templateFor(input.system);
  if (!tpl) return null;
  const db = getDb();
  const interval = input.interval && tpl.intervals.includes(input.interval as any) ? input.interval : tpl.intervals[tpl.intervals.length - 1];
  const items: ChecklistItem[] = checklistFor(input.system, interval);
  const info = db.prepare(
    `INSERT INTO inspections (number, office, account_id, customer, address, contact, system, code, interval, status, inspector, inspected_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, datetime('now'), ?)`
  ).run(
    nextNumber(), off(input.office), input.account_id ?? null, input.customer || null, input.address || null, input.contact || null,
    tpl.system, tpl.code, interval, input.inspector || input.created_by || null, input.created_by || null,
  );
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare(`INSERT INTO inspection_items (inspection_id, item_key, text, freq, kind, ref, sort) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => { items.forEach((it, i) => ins.run(id, it.key, it.text, it.freq, it.kind, it.ref || null, i)); });
  tx();
  return getInspection(id);
}

export function listInspections(office = '', status = ''): Array<Inspection & { fail_count: number; total: number }> {
  const db = getDb();
  const key = off(office);
  const where: string[] = []; const args: any = {};
  if (key) { where.push('os_office_key(i.office) = @office'); args.office = key; }
  if (status) { where.push('i.status = @status'); args.status = status; }
  const sql = `SELECT i.*,
      (SELECT COUNT(*) FROM inspection_items x WHERE x.inspection_id = i.id AND x.result = 'fail') AS fail_count,
      (SELECT COUNT(*) FROM inspection_items x WHERE x.inspection_id = i.id) AS total
    FROM inspections i ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.updated_at DESC LIMIT 300`;
  return db.prepare(sql).all(args) as any[];
}

const INSPECTION_FIELDS = ['customer', 'address', 'contact', 'inspector', 'interval', 'notes', 'account_id', 'office'] as const;

export function updateInspection(id: number, patch: Record<string, any>): InspectionWithItems | null {
  const cur = getInspection(id);
  if (!cur) return null;
  const sets: string[] = []; const args: any[] = [];
  for (const f of INSPECTION_FIELDS) {
    if (patch[f] === undefined) continue;
    let v: any = patch[f];
    if (f === 'office') v = off(v);
    if (f === 'account_id') v = v === null || v === '' ? null : Number(v);
    sets.push(`${f} = ?`); args.push(v);
  }
  if (!sets.length) return cur;
  args.push(id);
  getDb().prepare(`UPDATE inspections SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...args);
  return getInspection(id);
}

/** Mark one checklist line pass | fail | na (or clear it) with an optional note. */
export function setItemResult(itemId: number, result: string, note?: string): InspectionItem | null {
  const clean = ['pass', 'fail', 'na', ''].includes(result) ? result : '';
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inspection_items WHERE id = ?`).get(itemId) as InspectionItem | undefined;
  if (!row) return null;
  if (note !== undefined) db.prepare(`UPDATE inspection_items SET result = ?, note = ? WHERE id = ?`).run(clean, note || null, itemId);
  else db.prepare(`UPDATE inspection_items SET result = ? WHERE id = ?`).run(clean, itemId);
  db.prepare(`UPDATE inspections SET updated_at = datetime('now') WHERE id = ?`).run(row.inspection_id);
  return db.prepare(`SELECT * FROM inspection_items WHERE id = ?`).get(itemId) as InspectionItem;
}

/**
 * Finalize an inspection. Overall result is Unsatisfactory if any line failed, else Satisfactory.
 * Each failed line that hasn't already spawned one is written to the deficiencies backlog
 * (source='inspection'), so the failures become quotable repair work.
 */
export function finalizeInspection(id: number, actor?: string): (InspectionWithItems & { deficiencies_created: number }) | null {
  const db = getDb();
  const cur = getInspection(id);
  if (!cur) return null;
  const fails = cur.items.filter((i) => i.result === 'fail');
  const result = fails.length ? 'Unsatisfactory' : 'Satisfactory';
  const insp = cur.inspection;

  const insertDef = db.prepare(
    `INSERT INTO deficiencies (account_id, company_name, location_name, description, status, severity, proposed_usd, quoted, office, reported_at, source)
     VALUES (?, ?, ?, ?, 'open', ?, 0, 0, ?, datetime('now'), 'inspection')`
  );
  let created = 0;
  const tx = db.transaction(() => {
    for (const it of fails) {
      if (it.deficiency_id) continue; // already pushed on a prior finalize
      const desc = `${it.text}${it.note ? ` - ${it.note}` : ''} [${insp.code || 'NFPA'} ${it.ref || ''}]`.trim();
      const info = insertDef.run(insp.account_id ?? null, insp.customer || null, insp.address || null, desc, it.kind === 'test' ? 'high' : 'medium', insp.office || '');
      db.prepare(`UPDATE inspection_items SET deficiency_id = ? WHERE id = ?`).run(Number(info.lastInsertRowid), it.id);
      created++;
    }
    db.prepare(`UPDATE inspections SET status = 'complete', result = ?, inspector = COALESCE(inspector, ?), inspected_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(result, actor || null, id);
  });
  tx();
  const out = getInspection(id)!;
  return { ...out, deficiencies_created: created };
}

export function deleteInspection(id: number): boolean {
  const db = getDb();
  db.prepare(`DELETE FROM inspection_items WHERE inspection_id = ?`).run(id);
  return db.prepare(`DELETE FROM inspections WHERE id = ?`).run(id).changes > 0;
}
