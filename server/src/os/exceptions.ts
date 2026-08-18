/**
 * Exceptions engine (Phase 3).
 *
 * An exception is anything where reality does not match the intended process: repair revenue left
 * unquoted, a terminated employee who still has access, AR past 90 days. One generic object serves
 * every department. Detection is idempotent (deduped by a stable key) and self-healing: when a
 * detected condition clears, its still-open exception is auto-resolved, so the queue reflects the
 * present, not a pile of stale alerts. A person's own resolve/dismiss decisions are never overwritten.
 *
 * Office scope: exceptions carry a canonical office key (or NULL for company-wide) and are listed
 * through officeScopeClause() plus the company-wide rows, so a scoped caller sees exactly their
 * office's exceptions and shared company-wide ones — never another office's.
 */
import { getDb } from '../db/index';
import { OsContext, officeScopeClause, resolveOffice } from './scope';
import { canonicalOffice, officeLabel } from './office';

const AVG_REPAIR_USD = 650;
const USER_DECIDED = ['resolved', 'dismissed', 'ignored']; // never auto-overwrite these

export interface DetectResult { category: string; open: number; autoResolved: number }

interface Detected {
  dedupe_key: string; category: string; source_system: string; office: string | null;
  subject_type: string; subject_id: string | null; title: string; description: string;
  severity: string; financial_impact: number; financial_projected: number; owner_team: string; count: number;
}

/** Run all detectors. Idempotent: safe to call on every sync. */
export function detectExceptions(): DetectResult[] {
  const db = getDb();
  const results: DetectResult[] = [];
  const detectors = [detectDeficiencyAging, detectTerminatedAccess, detectArAging, detectUnattributedJobs, detectMissingContact];
  for (const detector of detectors) {
    let found: Detected[] = [];
    try { found = detector(db); } catch { found = []; }
    results.push(reconcile(db, detector.category, found));
  }
  return results;
}

/** Upsert the detected exceptions for a category and auto-resolve open ones no longer present. */
function reconcile(db: any, category: string, found: Detected[]): DetectResult {
  const upsert = db.prepare(
    `INSERT INTO exceptions (dedupe_key, category, source_system, office, subject_type, subject_id, title, description,
        severity, financial_impact, financial_projected, owner_team, count, status, updated_at)
     VALUES (@dedupe_key, @category, @source_system, @office, @subject_type, @subject_id, @title, @description,
        @severity, @financial_impact, @financial_projected, @owner_team, @count, 'open', datetime('now'))
     ON CONFLICT(dedupe_key) DO UPDATE SET
        title=excluded.title, description=excluded.description, severity=excluded.severity,
        financial_impact=excluded.financial_impact, financial_projected=excluded.financial_projected,
        count=excluded.count, updated_at=datetime('now'),
        -- reopen an auto-resolved item if the condition returned; never touch a user's decision
        status=CASE WHEN exceptions.status IN ('resolved','dismissed','ignored') AND exceptions.resolution='auto: condition cleared'
                    THEN 'open' ELSE exceptions.status END`
  );
  const keys = new Set<string>();
  const tx = db.transaction(() => { for (const d of found) { upsert.run(d); keys.add(d.dedupe_key); } });
  tx();

  // Auto-resolve still-open exceptions of this category whose key is gone.
  const open = db.prepare(`SELECT id, dedupe_key, status FROM exceptions WHERE category = ? AND status NOT IN ('resolved','dismissed','ignored')`).all(category) as any[];
  const resolve = db.prepare(`UPDATE exceptions SET status='resolved', resolved_at=datetime('now'), resolution='auto: condition cleared', updated_at=datetime('now') WHERE id = ?`);
  let autoResolved = 0;
  for (const row of open) if (!keys.has(row.dedupe_key)) { resolve.run(row.id); autoResolved++; }
  return { category, open: found.length, autoResolved };
}

/* ── detectors ── each returns the CURRENT set of exceptions for its category ── */

function detectDeficiencyAging(db: any): Detected[] {
  const rows = db.prepare(
    `SELECT os_office_key(office) k, COUNT(*) n FROM deficiencies
       WHERE lower(status) NOT IN ('fixed','invalid','canceled','cancelled','deleted','closed')
         AND COALESCE(quoted,0)=0 AND reported_at IS NOT NULL
         AND julianday('now') - julianday(reported_at) > 30
       GROUP BY k HAVING n > 0`
  ).all() as { k: string; n: number }[];
  return rows.filter((r) => r.k).map((r) => ({
    dedupe_key: `def_aging:${r.k}`, category: 'deficiency_aging', source_system: 'servicetrade', office: r.k,
    subject_type: 'office', subject_id: r.k,
    title: `${r.n} deficiencies over 30 days without a quote`,
    description: `${officeLabel(r.k)} has ${r.n} open deficiencies older than 30 days with no repair quote. Quotable repair revenue is sitting unsold.`,
    severity: r.n >= 50 ? 'high' : 'medium', financial_impact: r.n * AVG_REPAIR_USD, financial_projected: 1,
    owner_team: 'operations', count: r.n,
  }));
}
detectDeficiencyAging.category = 'deficiency_aging';

function detectTerminatedAccess(db: any): Detected[] {
  const rows = db.prepare(
    `SELECT e.id, e.legal_first_name, e.legal_last_name, e.preferred_name, e.office, COUNT(a.id) n
       FROM employees e JOIN employee_access a ON a.employee_id = e.id
       WHERE e.employment_status='terminated' AND a.status IN ('provisioned','approved')
       GROUP BY e.id HAVING n > 0`
  ).all() as any[];
  return rows.map((e) => {
    const name = e.preferred_name || [e.legal_first_name, e.legal_last_name].filter(Boolean).join(' ') || `Employee ${e.id}`;
    const key = canonicalOffice(e.office) || null;
    return {
      dedupe_key: `term_access:${e.id}`, category: 'terminated_access', source_system: 'bamboo', office: key,
      subject_type: 'employee', subject_id: String(e.id),
      title: `${name} is terminated but still has ${e.n} active access${e.n === 1 ? '' : 'es'}`,
      description: `A terminated employee still holds ${e.n} provisioned system access${e.n === 1 ? '' : 'es'}. Security and license-cost exposure.`,
      severity: 'high', financial_impact: 0, financial_projected: 0, owner_team: 'it', count: e.n,
    };
  });
}
detectTerminatedAccess.category = 'terminated_access';

function detectArAging(db: any): Detected[] {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount),0) usd, COUNT(*) n FROM invoices
       WHERE status != 'paid' AND due_at IS NOT NULL AND julianday('now') - julianday(due_at) > 90`
  ).get() as { usd: number; n: number };
  if (!row || row.n === 0) return [];
  return [{
    dedupe_key: 'ar_90:company', category: 'ar_aging', source_system: 'invoices', office: null,
    subject_type: 'company', subject_id: null,
    title: `$${fmt(row.usd)} in AR is over 90 days`,
    description: `${row.n} invoice${row.n === 1 ? '' : 's'} totaling $${fmt(row.usd)} are more than 90 days past due. Cash earned but not collected. (Company-wide until Intacct is connected.)`,
    severity: row.usd >= 500000 ? 'critical' : 'high', financial_impact: Math.round(row.usd), financial_projected: 0,
    owner_team: 'accounting', count: row.n,
  }];
}
detectArAging.category = 'ar_aging';

/**
 * Accounting handoff: jobs completed in the last 90 days with NO office/entity assigned. Accounting
 * cannot bill to the right LLC until the job is attributed. Company-wide roll-up (they have no office
 * by definition).
 */
function detectUnattributedJobs(db: any): Detected[] {
  const row = db.prepare(
    `SELECT COUNT(*) n FROM crm_jobs
       WHERE source='servicetrade' AND completed_at IS NOT NULL
         AND julianday('now') - julianday(completed_at) <= 90
         AND (office_name IS NULL OR office_name = '')`
  ).get() as { n: number };
  if (!row || row.n === 0) return [];
  return [{
    dedupe_key: 'handoff_no_office:company', category: 'handoff_missing_office', source_system: 'servicetrade', office: null,
    subject_type: 'company', subject_id: null,
    title: `${row.n} completed job${row.n === 1 ? '' : 's'} have no office/entity assigned`,
    description: `${row.n} job${row.n === 1 ? '' : 's'} completed in the last 90 days carry no ServiceTrade assignedOffice, so accounting cannot bill them to the correct LLC without research.`,
    severity: row.n >= 20 ? 'high' : 'medium', financial_impact: 0, financial_projected: 0, owner_team: 'accounting', count: row.n,
  }];
}
detectUnattributedJobs.category = 'handoff_missing_office';

/**
 * Accounting handoff: completed jobs (last 90 days) with no customer contact email OR phone, per
 * office. Collections/billing can't reach the customer. Grouped by office so each branch owns its own.
 */
function detectMissingContact(db: any): Detected[] {
  const rows = db.prepare(
    `SELECT os_office_key(office_name) k, COUNT(*) n FROM crm_jobs
       WHERE source='servicetrade' AND completed_at IS NOT NULL
         AND julianday('now') - julianday(completed_at) <= 90
         AND COALESCE(contact_email,'')='' AND COALESCE(contact_phone,'')=''
         AND office_name IS NOT NULL AND office_name != ''
       GROUP BY k HAVING n >= 5`
  ).all() as { k: string; n: number }[];
  return rows.filter((r) => r.k).map((r) => ({
    dedupe_key: `handoff_no_contact:${r.k}`, category: 'handoff_missing_contact', source_system: 'servicetrade', office: r.k,
    subject_type: 'office', subject_id: r.k,
    title: `${r.n} completed jobs missing customer contact`,
    description: `${officeLabel(r.k)} has ${r.n} jobs completed in the last 90 days with no customer email or phone on file, so billing and collections cannot reach the customer.`,
    severity: 'medium', financial_impact: 0, financial_projected: 0, owner_team: 'accounting', count: r.n,
  }));
}
detectMissingContact.category = 'handoff_missing_contact';

/* ── read/scope + actions ── */

export interface ExceptionFilter { status?: string; category?: string; owner?: string; severity?: string; office?: string }

export function listExceptions(ctx: OsContext, f: ExceptionFilter = {}): any[] {
  const db = getDb();
  const where: string[] = [];
  const params: any[] = [];

  // Office scope: the caller's authorized offices OR company-wide (office IS NULL) rows.
  const resolved = resolveOffice(ctx, f.office || 'all');
  const office = 'error' in resolved ? '__scoped__' : resolved.office;
  const scope = officeScopeClause('office', ctx, office);
  where.push(`(${scope.sql} OR office IS NULL)`);
  params.push(...scope.params);

  if (f.status === 'open') where.push(`status NOT IN ('resolved','dismissed','ignored')`);
  else if (f.status) { where.push('status = ?'); params.push(f.status); }
  if (f.category) { where.push('category = ?'); params.push(f.category); }
  if (f.owner) { where.push('owner_team = ?'); params.push(f.owner); }
  if (f.severity) { where.push('severity = ?'); params.push(f.severity); }

  const sql = `SELECT id, dedupe_key, category, source_system, office, subject_type, subject_id, title, description,
      severity, financial_impact, financial_projected, owner_team, assigned_user, status, count, detected_at, due_at, resolved_at, resolution
    FROM exceptions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'assigned' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'blocked' THEN 3 ELSE 9 END,
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      financial_impact DESC, detected_at DESC`;
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({ ...r, officeLabel: r.office ? officeLabel(r.office) : 'Company-wide' }));
}

export function exceptionSummary(ctx: OsContext): any {
  const open = listExceptions(ctx, { status: 'open' });
  const byOwner: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let impact = 0;
  for (const e of open) {
    byOwner[e.owner_team] = (byOwner[e.owner_team] || 0) + 1;
    bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
    impact += e.financial_impact || 0;
  }
  return { open: open.length, byOwner, bySeverity, financialImpact: impact };
}

/** Update status. Scope-checked: the caller must be authorized for the exception's office. */
export function setExceptionStatus(ctx: OsContext, id: number, status: string, note?: string): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare(`SELECT id, office FROM exceptions WHERE id = ?`).get(id) as { id: number; office: string | null } | undefined;
  if (!row) return { ok: false, error: 'not_found' };
  if (row.office && !ctx.allOffices && !ctx.offices.includes(row.office)) return { ok: false, error: 'office_forbidden' };
  const allowed = ['open', 'assigned', 'in_progress', 'resolved', 'dismissed', 'ignored', 'blocked'];
  if (!allowed.includes(status)) return { ok: false, error: 'bad_status' };
  const resolvedAt = status === 'resolved' ? "datetime('now')" : 'resolved_at';
  db.prepare(`UPDATE exceptions SET status = ?, resolution = COALESCE(?, resolution), resolved_at = ${resolvedAt}, updated_at = datetime('now') WHERE id = ?`)
    .run(status, note ?? null, id);
  return { ok: true };
}

function fmt(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
}
