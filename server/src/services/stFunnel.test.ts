import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `st-funnel-test-${process.pid}.db`);
process.env.DEMO_MODE = 'off';

import { initDb } from '../db/schema';
import { computeFunnel, buildReport, reportHtml, FunnelData } from './stFunnel';

initDb();
const t = (d: string) => Math.floor(Date.parse(`${d}T15:00:00Z`) / 1000);

// Two inspection jobs (Austin, Waco) found deficiencies; a repair job in Austin was invoiced.
const data: FunnelData = {
  jobs: [
    { id: 10, type: 'inspection', completedOn: t('2026-03-01'), customer: { id: 1 }, assignedOffice: { name: '1st FP Austin' } },
    { id: 20, type: 'inspection', completedOn: t('2026-04-01'), customer: { id: 2 }, assignedOffice: { name: '1st FP Waco' } },
    { id: 30, type: 'repair', completedOn: t('2026-05-01'), customer: { id: 1 }, assignedOffice: { name: '1st FP Austin' } },
  ],
  deficiencies: [
    { id: 1, reportedOn: t('2026-03-01'), job: { id: 10 } },
    { id: 2, reportedOn: t('2026-03-01'), job: { id: 10 } },
    { id: 3, reportedOn: t('2026-04-01'), job: { id: 20 } },
    { id: 4, reportedOn: t('2025-06-01'), job: { id: 99 } },
  ],
  quotes: [
    { id: 100, status: 'accepted', totalPrice: '2,500.00', latestSubmission: t('2026-03-11'), deficiencyJobs: [{ id: 10 }] },
    { id: 200, status: 'submitted', totalPrice: '1,000.00', latestSubmission: t('2026-04-05'), deficiencyJobs: [{ id: 20 }] },
    { id: 300, status: 'draft', totalPrice: '500.00', latestSubmission: null, deficiencyJobs: [] },
  ],
  invoices: [
    { id: 1000, totalPrice: 2500, transactionDate: t('2026-05-02'), job: { id: 30 } },
    { id: 1001, totalPrice: 400, transactionDate: t('2026-05-02'), job: { id: 10 } },
  ],
};
const ytd = { label: '2026', from: '2026-01-01', to: '2026-10-07' };

test('the funnel counts each stage and links deficiencies to their quotes by job', () => {
  const n = computeFunnel(data, ytd);
  assert.deepEqual(n.deficiencies, { count: 3, quoted: 3, quotedUsd: 3500 });
  assert.deepEqual(n.quotesSent, { count: 2, usd: 3500 });
  assert.deepEqual(n.quotesApproved, { count: 1, usd: 2500 });
  assert.deepEqual(n.repairsInvoiced, { count: 1, usd: 2500 }, 'the inspection invoice is not a repair');
  assert.equal(n.daysToQuote.pairs, 3);
  assert.equal(n.daysToQuote.avg, 8, '(10 + 10 + 4) / 3');
});

test('one office sees only its own work', () => {
  const austin = computeFunnel(data, ytd, 'austin');
  assert.equal(austin.deficiencies.count, 2);
  assert.equal(austin.quotesSent.count, 1);
  assert.equal(austin.repairsInvoiced.usd, 2500);
  const waco = computeFunnel(data, ytd, 'waco');
  assert.equal(waco.deficiencies.count, 1);
  assert.equal(waco.repairsInvoiced.usd, 0);
});

test('the report covers last year, this year and the last 12 months, by office, and renders', () => {
  const r = buildReport(data, new Date('2026-10-07T15:00:00Z'));
  assert.deepEqual(r.periods.map((p) => p.period.label), ['2025', '2026 to date', 'Last 12 months']);
  assert.equal(r.periods[0].total.deficiencies.count, 1);
  assert.equal(r.customers.activeAccounts, 2);
  assert.deepEqual(r.byOffice.rows.map((o) => o.office).sort(), ['austin', 'waco']);
  const html = reportHtml(r);
  assert.match(html, /Repairs invoiced/);
  assert.match(html, /\$2,500/);
  assert.doesNotMatch(html, /—|–/);
});

test('quotes, deficiencies and invoices with no job office take the office that serves that location or customer', () => {
  const d: FunnelData = {
    jobs: [
      { id: 10, type: 'inspection', completedOn: t('2026-03-01'), customer: { id: 7 }, location: { id: 70 }, assignedOffice: { name: '1st FP Waco' } },
      { id: 11, type: 'inspection', completedOn: t('2026-03-02'), customer: { id: 7 }, location: { id: 71 }, assignedOffice: { name: '1st FP Houston' } },
      { id: 12, type: 'inspection', completedOn: t('2026-03-03'), customer: { id: 7 }, location: { id: 72 }, assignedOffice: { name: '1st FP Houston' } },
    ],
    deficiencies: [
      { id: 1, reportedOn: t('2026-03-01'), location: { id: 70 } },                  // by location: Waco
      { id: 2, reportedOn: t('2026-03-01'), location: { id: 999, address: { city: 'Lubbock' } } }, // by city
      { id: 3, reportedOn: t('2026-03-01') },                                          // nothing to go on
    ],
    quotes: [{ id: 1, status: 'submitted', totalPrice: '100', latestSubmission: t('2026-03-05'), customer: { id: 7 } }], // customer: Houston (2 of 3 jobs)
    invoices: [{ id: 1, totalPrice: 50, transactionDate: t('2026-03-06'), job: { id: 555, type: 'service_call' }, location: { id: 70 } }],
  };
  assert.equal(computeFunnel(d, ytd, 'waco').deficiencies.count, 1);
  assert.equal(computeFunnel(d, ytd, 'lubbock').deficiencies.count, 1);
  assert.equal(computeFunnel(d, ytd, 'houston').quotesSent.count, 1);
  assert.equal(computeFunnel(d, ytd, 'waco').repairsInvoiced.usd, 50);
  const r = buildReport(d, new Date('2026-10-07T15:00:00Z'));
  const none = r.byOffice.rows.find((x) => x.label === 'Office not identified')!;
  assert.equal(none.n.deficiencies.count, 1, 'whatever cannot be placed is shown, so offices add up to the total');
  assert.match(reportHtml(r), /Completed jobs by type: inspection \(3\)/);
});
