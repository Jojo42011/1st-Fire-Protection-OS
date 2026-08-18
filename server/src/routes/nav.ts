import { Router } from 'express';
import { getDb } from '../db/index';

/**
 * Shell chrome data (Phase 2 of the Signal revamp):
 *   GET /api/nav-counts  — the sidebar badges / activity counts
 *   GET /api/search      — the ⌘K palette (customers + actions)
 *
 * Real where the data already exists (calls, invoices, reviews, license reclaims);
 * fixtures for the CRM screens that land in Phase 4 (accounts, pipeline), reported
 * with live:false so nothing pretends to be a ServiceTrade integration yet.
 */
const router = Router();

const num = (sql: string): number => {
  try {
    return (getDb().prepare(sql).get() as { v: number }).v || 0;
  } catch {
    return 0;
  }
};

const fmtMoney = (dollars: number): string =>
  dollars >= 1e6 ? '$' + (dollars / 1e6).toFixed(1) + 'M' : dollars >= 1e3 ? '$' + Math.round(dollars / 1e3) + 'k' : '$' + Math.round(dollars);

router.get('/api/nav-counts', (_req, res) => {
  // "Needs your yes" reads from the unified approvals inbox (Phase 3 source of truth).
  const approvals = num(`SELECT COUNT(*) AS v FROM approvals WHERE status = 'pending'`);

  // Live CRM counts once ServiceTrade data is mirrored; the old fixtures only for keyless demo.
  const acctCount = num(`SELECT COUNT(*) AS v FROM accounts WHERE source = 'servicetrade'`);
  const real = acctCount > 0;
  const loc = (n: number) => n.toLocaleString('en-US');
  const openQuoteCents = num(
    `SELECT COALESCE(SUM(amount_cents), 0) AS v FROM quotes WHERE source = 'servicetrade' AND lower(stage) IN ('draft','submitted','pending','reviewed')`
  );

  res.json({
    approvals,
    phones: num(`SELECT COUNT(*) AS v FROM calls WHERE date(started_at) = date('now')`),
    money: num(`SELECT COUNT(*) AS v FROM invoices WHERE status != 'paid'`),
    reviews: num(`SELECT COUNT(*) AS v FROM reviews WHERE reply_status IN ('none','draft') AND stars <= 3`),
    reviewRequests: (() => { const n = num(`SELECT COUNT(*) AS v FROM review_requests WHERE source = 'servicetrade' AND status = 'held'`); return n > 0 ? String(n) : ''; })(),
    spend: num(`SELECT COUNT(*) AS v FROM license_reclaims WHERE status = 'proposed'`),
    // Honest-empty when ServiceTrade is not connected — never a fabricated production number.
    accounts: real ? loc(acctCount) : '',
    sites: real ? loc(num(`SELECT COUNT(*) AS v FROM sites WHERE source = 'servicetrade'`)) : '',
    jobs: real ? loc(num(`SELECT COUNT(*) AS v FROM crm_jobs WHERE source = 'servicetrade'`)) : '',
    quotes: real ? loc(num(`SELECT COUNT(*) AS v FROM quotes WHERE source = 'servicetrade'`)) : '',
    pipeline: real ? fmtMoney(openQuoteCents / 100) : '',
    live: real,
  });
});

router.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const db = getDb();
  let customers: Array<{ name: string; monogram: string; amount: number; days: number; screen: string }> = [];

  try {
    const like = `%${q}%`;
    const rows = db
      .prepare(
        `SELECT customer, amount, due_at, status FROM invoices
           WHERE (? = '' OR lower(customer) LIKE ?) AND status != 'paid'
           ORDER BY amount DESC LIMIT 6`
      )
      .all(q, like) as Array<{ customer: string; amount: number; due_at: string | null; status: string }>;

    customers = rows.map((r) => {
      const days =
        r.due_at != null ? Math.max(0, Math.round((Date.now() - new Date(r.due_at).getTime()) / 86400000)) : 0;
      const monogram =
        r.customer
          .split(/\s+/)
          .map((w) => w[0])
          .join('')
          .slice(0, 2)
          .toUpperCase() || '?';
      return { name: r.customer, monogram, amount: r.amount, days, screen: 'money' };
    });
  } catch {
    customers = [];
  }

  // A small, stable set of "do something" actions. Every one navigates to a real screen.
  const actions = [
    { label: 'Review the pending approvals', kind: 'mail', screen: 'approve', key: 'D' },
    { label: 'Ask the Operator about the business', kind: 'brain', screen: 'operator' },
    { label: "See today's call history", kind: 'phone', screen: 'phones' },
  ];

  res.json({ customers, actions, live: false });
});

export default router;
