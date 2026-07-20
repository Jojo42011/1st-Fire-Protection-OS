import { Router } from 'express';
import { getDb } from '../db/index';
import { getCallMetrics } from '../services/receptionist';
import { getReputationSummary } from '../services/reviewAgent';
import { getReceivablesSummary } from '../services/invoiceAgent';
import { telephonyEnabled } from '../config/voice';
import { integrationConnected } from '../config/integrations';

const router = Router();

/** Group thousands with commas (ICU-independent so it works on any Node build). */
function withCommas(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Format a dollar amount compactly for an at-a-glance exec view. */
function money(n: number): string {
  if (n >= 1_000_000) {
    const s = (n / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `$${s}M`;
  }
  if (n >= 1000) return `$${withCommas(n)}`;
  return `$${Math.round(n)}`;
}

/**
 * GET /api/impact: the executive rollup.
 *
 * Composes the three front-facing agents' REAL summaries into three at-a-glance blocks
 * (one headline number + one supporting figure + one plain ROI line each). Numbers are
 * derived only from the same functions the operator pages use:
 *   - Call Receptionist -> getCallMetrics() + a COUNT of answered calls
 *   - Review Collector  -> getReputationSummary()
 *   - Invoice Collector -> getReceivablesSummary()
 *
 * Each block carries a `sample` flag: true when the number is coming from seed / illustrative
 * data (no live provider connected), false once a real provider is feeding it. This mirrors
 * the `live` flag on each operator route, so nothing is ever shown as verified when it is not.
 * Keyless-safe: renders entirely from seed data with zero API keys.
 */
router.get('/api/impact', (_req, res) => {
  const db = getDb();

  // ---- Call Receptionist ----
  const calls = getCallMetrics();
  const callsAnswered = (db.prepare(`SELECT COUNT(*) AS v FROM calls`).get() as { v: number }).v;
  const callsSample = !telephonyEnabled();

  // ---- Review Collector ----
  const rep = getReputationSummary();
  const reviewsSample = !integrationConnected('google_business');

  // ---- Invoice Collector ----
  const recv = getReceivablesSummary();
  const invoicesSample = !(integrationConnected('servicetrade') || integrationConnected('stripe'));

  res.json({
    period: 'This month',
    generatedAt: new Date().toISOString(),
    agents: [
      {
        key: 'calls',
        name: 'Call Receptionist',
        headline: String(callsAnswered),
        label: 'Calls answered',
        sub: `${calls.leadsCaptured} leads captured`,
        roi: 'every call answered, day or night',
        sample: callsSample,
      },
      {
        key: 'reviews',
        name: 'Review Collector',
        headline: rep.avgRating ? rep.avgRating.toFixed(1) : '0.0',
        label: 'Star rating',
        sub: `+${rep.thisMonthDelta} new this month`,
        roi: 'reviews that win the next job',
        sample: reviewsSample,
      },
      {
        key: 'invoices',
        name: 'Invoice Collector',
        headline: money(recv.totalOutstanding),
        label: 'In collection',
        sub: `${money(recv.collectedThisMonth)} collected this month`,
        roi: 'invoices chased until they are paid',
        sample: invoicesSample,
      },
    ],
  });
});

export default router;
