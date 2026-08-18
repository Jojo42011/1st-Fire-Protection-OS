import { Router } from 'express';
import { getDb } from '../db/index';
import { getCallMetrics } from '../services/receptionist';
import { currentContext, resolveOffice, officeScopeClause, allowedOffices } from '../os/scope';
import { officeLabel } from '../os/office';

/**
 * GET /api/home — the decision page.
 *
 * Answers, for the caller's authorized office scope: what needs attention, where money and work are
 * stuck, and how the office/company is doing. Office scope is enforced in SQL via officeScopeClause()
 * on every table that actually carries an office. Tables that do NOT yet carry an office (the invoices
 * fixture used for AR) are reported company-wide and labeled honestly, never silently mis-scoped.
 */
const router = Router();

const AVG_REPAIR_USD = 650; // matches deficiencySync projection; only ever labeled "projected"
const CLOSED_DEF = `lower(status) NOT IN ('fixed','invalid','canceled','cancelled','deleted','closed')`;

router.get('/api/home', (req, res) => {
  const db = getDb();
  const ctx = currentContext(req);

  // The client sends the selected office as the raw office value (or 'all'); may also arrive via cookie.
  const requested = (req.query.office as string) || readCookie(req.headers.cookie, 'fpos_office') || 'all';
  const resolved = resolveOffice(ctx, requested);
  if ('error' in resolved) return res.status(resolved.status).json({ ok: false, error: resolved.error });
  const office = resolved.office;
  const officeName = office === 'all' || office === '__scoped__' ? 'All offices' : officeLabel(office);

  const num = (sql: string, params: any[] = []): number => {
    try { return (db.prepare(sql).get(...params) as { v: number }).v || 0; } catch { return 0; }
  };

  // ---- office-scoped operating metrics (real, from the ServiceTrade mirror) ----
  const defScope = officeScopeClause('office', ctx, office);
  const openDef = num(`SELECT COUNT(*) v FROM deficiencies WHERE ${CLOSED_DEF} AND ${defScope.sql}`, defScope.params);
  const unquotedDef = num(`SELECT COUNT(*) v FROM deficiencies WHERE ${CLOSED_DEF} AND COALESCE(quoted,0)=0 AND ${defScope.sql}`, defScope.params);
  const unquotedOld = num(
    `SELECT COUNT(*) v FROM deficiencies WHERE ${CLOSED_DEF} AND COALESCE(quoted,0)=0
       AND reported_at IS NOT NULL AND julianday('now') - julianday(reported_at) > 30 AND ${defScope.sql}`,
    defScope.params
  );
  const quotedRepairUsd = num(`SELECT COALESCE(SUM(proposed_usd),0) v FROM deficiencies WHERE ${CLOSED_DEF} AND ${defScope.sql}`, defScope.params);
  const projectedRepairUsd = unquotedDef * AVG_REPAIR_USD;

  const qScope = officeScopeClause('office', ctx, office);
  const openPipelineCents = num(
    `SELECT COALESCE(SUM(amount_cents),0) v FROM quotes WHERE source='servicetrade'
       AND lower(stage) IN ('draft','submitted','pending','reviewed','contingent') AND ${qScope.sql}`,
    qScope.params
  );

  const jScope = officeScopeClause('office_name', ctx, office);
  const jobsCompleted30 = num(
    `SELECT COUNT(*) v FROM crm_jobs WHERE completed_at IS NOT NULL
       AND julianday('now') - julianday(completed_at) <= 30 AND ${jScope.sql}`,
    jScope.params
  );

  // ---- company-wide signals (no office column yet — labeled honestly) ----
  const arOutstanding = num(`SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE status != 'paid'`);
  const ar90 = num(`SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE status != 'paid' AND due_at IS NOT NULL AND julianday('now') - julianday(due_at) > 90`);
  const ar90Count = num(`SELECT COUNT(*) v FROM invoices WHERE status != 'paid' AND due_at IS NOT NULL AND julianday('now') - julianday(due_at) > 90`);
  const pendingApprovals = num(`SELECT COUNT(*) v FROM approvals WHERE status = 'pending'`);

  // People readiness (company-wide; People has its own office story later).
  const startingSoon = num(
    `SELECT COUNT(*) v FROM employees WHERE employment_status='onboarding'
       AND anticipated_start_date IS NOT NULL AND julianday(anticipated_start_date) - julianday('now') BETWEEN 0 AND 3`
  );
  const termWithAccess = num(
    `SELECT COUNT(DISTINCT e.id) v FROM employees e JOIN employee_access a ON a.employee_id = e.id
       WHERE e.employment_status='terminated' AND a.status IN ('provisioned','approved')`
  );

  // ---- Needs Attention: only real signals, each with why-it-matters + a drill-down target ----
  const attention: any[] = [];
  if (pendingApprovals > 0)
    attention.push({ key: 'approvals', title: `${pendingApprovals} approval${pendingApprovals === 1 ? '' : 's'} waiting`, why: 'Work is blocked until someone says yes', count: pendingApprovals, tone: 'amber', screen: 'approve', scope: 'company' });
  if (unquotedOld > 0)
    attention.push({ key: 'deficiencies', title: `${unquotedOld} deficiencies over 30 days, no quote`, why: 'Repair revenue is sitting unsold', amount: unquotedOld * AVG_REPAIR_USD, amountProjected: true, count: unquotedOld, tone: 'red', screen: 'deficiencies', scope: office });
  if (ar90 > 0)
    attention.push({ key: 'ar90', title: `$${fmt(ar90)} in AR is over 90 days`, why: 'Cash earned but not collected', amount: ar90, count: ar90Count, tone: 'red', screen: 'receivables', scope: 'company' });
  if (termWithAccess > 0)
    attention.push({ key: 'term_access', title: `${termWithAccess} terminated employee${termWithAccess === 1 ? '' : 's'} still has access`, why: 'A security and license-cost exposure', count: termWithAccess, tone: 'red', screen: 'people', scope: 'company' });
  if (startingSoon > 0)
    attention.push({ key: 'starting_soon', title: `${startingSoon} start${startingSoon === 1 ? 's' : ''} within 3 days`, why: 'Confirm Day-1 readiness before they arrive', count: startingSoon, tone: 'amber', screen: 'people', scope: 'company' });

  const hour = new Date().getHours();
  const greeting = `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}.`;

  res.json({
    ok: true,
    office,
    officeName,
    canSeeAllOffices: ctx.allOffices,
    officeCount: allowedOffices(ctx).length,
    greeting,
    attention,
    kpis: {
      repairOpportunity: { quoted: quotedRepairUsd, projected: projectedRepairUsd, openDeficiencies: openDef, unquoted: unquotedDef, sub: `${openDef} open · ${unquotedDef} unquoted` },
      pipeline: { value: Math.round(openPipelineCents / 100), sub: 'open quotes' },
      jobsCompleted: { value: jobsCompleted30, sub: 'last 30 days' },
      ar: { value: arOutstanding, ninety: ar90, sub: `$${fmt(ar90)} over 90 days`, companyWide: true },
      phones: (() => { const cm = getCallMetrics(); return { value: cm.callsToday, sub: `${cm.leadsCaptured} new leads`, companyWide: true }; })(),
    },
  });
});

function fmt(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
}
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export default router;
