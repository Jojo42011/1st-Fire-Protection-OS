import { Router } from 'express';
import { getDb } from '../db/index';
import { getCallMetrics } from '../services/receptionist';

/**
 * GET /api/home — the screen-1 aggregate: money, calls, reputation and recoverable spend
 * in one shot, plus who owes you money and the first few things that need a yes. Real where
 * the data exists; a couple of headline figures (DSO, recovered) are fixtures matching the
 * design until the CRM/ServiceTrade data lands.
 */
const router = Router();

const one = (sql: string): number => {
  try {
    return (getDb().prepare(sql).get() as { v: number }).v || 0;
  } catch {
    return 0;
  }
};

const initials = (name: string): string =>
  name
    .replace(/[^A-Za-z0-9 ]/g, '')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

router.get('/api/home', (_req, res) => {
  const db = getDb();

  // ---- money ----
  const outstanding = one(`SELECT COALESCE(SUM(amount),0) AS v FROM invoices WHERE status != 'paid'`);
  const openCount = one(`SELECT COUNT(*) AS v FROM invoices WHERE status != 'paid'`);
  const risk90 = one(
    `SELECT COALESCE(SUM(amount),0) AS v FROM invoices WHERE status != 'paid' AND due_at IS NOT NULL AND julianday('now') - julianday(due_at) > 90`
  );
  const risk90Count = one(
    `SELECT COUNT(*) AS v FROM invoices WHERE status != 'paid' AND due_at IS NOT NULL AND julianday('now') - julianday(due_at) > 90`
  );

  // ---- calls ----
  const cm = getCallMetrics();

  // ---- reputation ----
  const avgStars = one(`SELECT COALESCE(ROUND(AVG(stars),1),0) AS v FROM reviews`);
  const reviewCount = one(`SELECT COUNT(*) AS v FROM reviews`);
  const reviewsMonth = one(`SELECT COUNT(*) AS v FROM reviews WHERE julianday('now') - julianday(received_at) <= 30`);

  // ---- wasted spend ----
  const reclaimYr = one(
    `SELECT COALESCE(SUM(cost_monthly),0) * 12 AS v FROM license_seats s
       JOIN license_reclaims r ON r.seat_id = s.id AND r.status = 'proposed'`
  );
  const reclaimSeats = one(`SELECT COUNT(*) AS v FROM license_reclaims WHERE status = 'proposed'`);

  // ---- who owes you money (top 4, oldest first) ----
  const invRows = db
    .prepare(
      `SELECT customer, amount, due_at,
              CAST(julianday('now') - julianday(due_at) AS INTEGER) AS days
         FROM invoices
        WHERE status != 'paid'
        ORDER BY (due_at IS NULL), due_at ASC
        LIMIT 4`
    )
    .all() as Array<{ customer: string; amount: number; due_at: string | null; days: number | null }>;

  const topInvoices = invRows.map((r) => {
    const days = r.days == null ? 0 : r.days;
    const late = days > 0;
    const tint = days > 90 ? 'money' : late ? 'amber' : 'gray';
    return {
      initials: initials(r.customer),
      customer: r.customer,
      amount: r.amount,
      days,
      ageLabel: late ? `${days} days late` : 'On time',
      ageTone: days > 90 ? 'money' : late ? 'amber' : 'green',
      tint,
    };
  });

  // ---- needs your yes ----
  const pendingCount = one(`SELECT COUNT(*) AS v FROM approvals WHERE status = 'pending'`);
  const approvals = db
    .prepare(
      `SELECT id, agent_key, kind, risk, title, stake, body, trail, status,
              CAST((julianday('now') - julianday(created_at)) * 24 * 60 AS INTEGER) AS age_mins
         FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 3`
    )
    .all();

  const hour = new Date().getHours();
  const greeting = `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, Devon.`;
  const pendingLine =
    pendingCount > 0 ? `${pendingCount} ${pendingCount === 1 ? 'thing needs' : 'things need'} your yes.` : 'Nothing needs your yes right now.';

  res.json({
    greeting,
    pendingCount,
    pendingLine,
    cashAtRisk: { amount: risk90, accounts: risk90Count, pct: outstanding > 0 ? Math.round((risk90 / outstanding) * 100) : 0 },
    kpis: {
      money: { value: outstanding, sub: `${openCount} open invoice${openCount === 1 ? '' : 's'}` },
      phones: { value: cm.callsToday, sub: `${cm.transferred} routed · ${cm.leadsCaptured} new leads` },
      reputation: { value: avgStars, sub: `${reviewCount} reviews · +${reviewsMonth} this month` },
      spend: { value: reclaimYr, sub: `${reclaimSeats} seat${reclaimSeats === 1 ? '' : 's'} to reclaim` },
    },
    topInvoices,
    approvals,
    live: false,
  });
});

export default router;
