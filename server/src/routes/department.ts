import { Router } from 'express';
import { listAgents } from '../services/agentRuntime';
import { DEPARTMENTS } from '../config/departments';

const router = Router();

/**
 * SAMPLE METRICS - deterministic, seed-derived.
 *
 * These fill the dashboards out so a walkthrough shows what each department and agent will
 * look like once it is wired to its real source (ServiceTrade, the phone system, accounting).
 * The `sample` flag is internal plumbing only and is not rendered in the UI. Values are seeded
 * from a small hash of the department / agent key so they are stable per key (they do not
 * jitter on every request), and no Math.random is used.
 */

interface SampleKpi {
  label: string;
  value: string;
  accent?: boolean;
  sample: true;
}
interface SampleFeedRow {
  action: string;
  when: string;
}

/** FNV-1a hash of a key -> unsigned 32-bit seed. */
function seedFrom(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a tiny deterministic PRNG seeded from the key. Same key, same sequence, always. */
function rngFrom(key: string): () => number {
  let a = seedFrom(key) >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer in [min, max]. */
function ri(r: () => number, min: number, max: number): number {
  return min + Math.floor(r() * (max - min + 1));
}

/** Money formatter: 438000 -> "$438K", 2400000 -> "$2.4M". */
function money(n: number): string {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return '$' + Math.round(n / 1000) + 'K';
  return '$' + n.toLocaleString('en-US');
}

/** Ascending age labels for a work feed (row 0 is the most recent). */
const FEED_AGES = ['just now', '1h ago', '3h ago', 'yesterday', '2 days ago', 'last week'];

/**
 * Headline KPIs per department, plausible for a ~$100M fire-protection company.
 * Seed-derived and deterministic.
 */
function deptSampleKpis(pillar: string): SampleKpi[] {
  const r = rngFrom('dept:' + pillar);
  const K = (label: string, value: string, accent?: boolean): SampleKpi => ({ label, value, accent, sample: true });

  switch (pillar) {
    case 'inspections':
      return [
        K('Recurring monthly revenue', money(ri(r, 415000, 485000)), true),
        K('Revenue under agreement', ri(r, 44, 53) + '%'),
        K('Open deficiencies', ri(r, 180, 260).toLocaleString('en-US')),
        K('Inspections due this week', String(ri(r, 62, 96))),
      ];
    case 'service':
      return [
        K('Emergency calls (7d)', String(ri(r, 12, 24)), true),
        K('Avg after-hours response', ri(r, 28, 46) + ' min'),
        K('Billable hrs / tech / day', (ri(r, 52, 64) / 10).toFixed(1)),
        K('Jobs completed today', String(ri(r, 38, 68))),
      ];
    case 'sales':
      return [
        K('Open pipeline value', money(ri(r, 1_800_000, 3_200_000)), true),
        K('Quotes out (30d)', String(ri(r, 60, 110))),
        K('Win rate by job type', ri(r, 32, 45) + '%'),
        K('Avg quote turnaround', (ri(r, 14, 26) / 10).toFixed(1) + ' days'),
      ];
    case 'projects':
      return [
        K('Active projects', String(ri(r, 24, 46)), true),
        K('Permits in flight', String(ri(r, 12, 28))),
        K('On-time closeout', ri(r, 78, 91) + '%'),
        K('Avg days sold to close', String(ri(r, 40, 75))),
      ];
    case 'finance':
      return [
        K('Days sales outstanding', ri(r, 42, 58) + ' days', true),
        K('Receivables past terms', money(ri(r, 380000, 620000))),
        K('Collected this month', money(ri(r, 2_100_000, 3_400_000))),
        K('Invoices sent (7d)', String(ri(r, 55, 95))),
      ];
    case 'hr':
      return [
        K('Open roles', String(ri(r, 6, 14)), true),
        K('Certs expiring (60d)', String(ri(r, 8, 19))),
        K('Avg time to productive', ri(r, 9, 14) + ' wks'),
        K('Applicants screened (30d)', String(ri(r, 40, 80))),
      ];
    case 'ops':
      return [
        K('Open escalations', String(ri(r, 5, 14)), true),
        K('Avg resolution time', (ri(r, 12, 26) / 10).toFixed(1) + ' days'),
        K('Branches reporting green', ri(r, 6, 9) + ' of 9'),
        K('Complaints this week', String(ri(r, 8, 20))),
      ];
    case 'vendors':
      return [
        K('Active suppliers', String(ri(r, 40, 70)), true),
        K('Open purchase orders', String(ri(r, 22, 48))),
        K('Price-creep flags', String(ri(r, 2, 7))),
        K('Supplier spend this month', money(ri(r, 640000, 1_100_000))),
      ];
    case 'reception':
      return [
        K('Calls answered (7d)', ri(r, 380, 620).toLocaleString('en-US'), true),
        K('After-hours captured (7d)', String(ri(r, 40, 90))),
        K('Routed to a human', ri(r, 14, 24) + '%'),
        K('Avg time to answer', ri(r, 2, 5) + 's'),
      ];
    case 'growth':
      return [
        K('Recurring pipeline (ARR)', money(ri(r, 900000, 1_900_000)), true),
        K('New permits caught (30d)', String(ri(r, 30, 70))),
        K('Competitor targets mapped', ri(r, 120, 260).toLocaleString('en-US')),
        K('Recurring capture rate', ri(r, 22, 38) + '%'),
      ];
    default:
      return [
        K('Items handled (7d)', String(ri(r, 30, 120)), true),
        K('In queue', String(ri(r, 4, 22))),
        K('Est. time saved (wk)', ri(r, 6, 24) + 'h'),
      ];
  }
}

interface AgentSample {
  metrics: SampleKpi[];
  feed: SampleFeedRow[];
}

/**
 * Per-agent metrics + a short work-feed, plausible for the agent's capability/role.
 * Seed-derived. Keyed off the agent's capability_id, with a role-aware default.
 */
function agentSample(agent: any): AgentSample {
  const cap = agent?.capability_id || '';
  const r = rngFrom('agent:' + (agent?.key || cap || 'x'));
  const M = (label: string, value: string, accent?: boolean): SampleKpi => ({ label, value, accent, sample: true });
  const feed = (rows: string[]): SampleFeedRow[] =>
    rows.slice(0, 5).map((action, i) => ({ action, when: FEED_AGES[i] || 'earlier' }));

  switch (cap) {
    case 'ai_receptionist':
      return {
        metrics: [
          M('Calls answered (7d)', ri(r, 380, 620).toLocaleString('en-US'), true),
          M('After-hours captured', String(ri(r, 40, 90))),
          M('Routed correctly', ri(r, 96, 99) + '%'),
        ],
        feed: feed([
          'Answered an after-hours service call, routed to the on-call tech',
          'Captured a lead: sprinkler install quote request',
          'Booked an inspection callback for tomorrow morning',
          'Took a Spanish-language service call, logged to Ops',
          'Routed a billing question to Finance',
        ]),
      };
    case 'invoice_chaser':
      return {
        metrics: [
          M('Receivables watched', money(ri(r, 380000, 620000)), true),
          M('Reminders drafted (7d)', String(ri(r, 18, 40))),
          M('Avg days to pay', String(ri(r, 38, 52))),
        ],
        feed: feed([
          'Drafted a friendly nudge on Invoice #4821, 34 days aged',
          'Flagged 3 invoices crossing 60-day terms',
          'Queued a firm reminder for approval, $18,400 balance',
          'Marked Invoice #4720 paid, cleared it from aging',
          'Escalated a 90-day account to the Finance lead',
        ]),
      };
    case 'review_engine':
      return {
        metrics: [
          M('Requests sent (7d)', String(ri(r, 40, 80)), true),
          M('Reviews landed', String(ri(r, 12, 30))),
          M('Avg rating', (ri(r, 46, 49) / 10).toFixed(1)),
        ],
        feed: feed([
          'Sent a review request after a sprinkler inspection closeout',
          'Captured a new 5-star review, drafted the reply',
          'Flagged a 3-star review for a manager response',
          'Sent a Spanish-language review request to a completed job',
          'Reply approved and posted to Google',
        ]),
      };
    case 'renewal_guardian':
      return {
        metrics: [
          M('Agreements watched', ri(r, 800, 1400).toLocaleString('en-US'), true),
          M('Renewals due (30d)', String(ri(r, 24, 60))),
          M('Silent lapses caught', String(ri(r, 3, 11))),
        ],
        feed: feed([
          'Flagged an ITM agreement renewing in 21 days, drafted outreach',
          'Caught an unscheduled annual inspection, queued the schedule',
          'Nudged a lapsed backflow agreement back on cadence',
          'Drafted renewal terms for a multi-site account',
          'Logged a renewed agreement to the recurring book',
        ]),
      };
    case 'deficiency_pipeline':
      return {
        metrics: [
          M('Open deficiencies', ri(r, 180, 260).toLocaleString('en-US'), true),
          M('Converted to repair (30d)', ri(r, 32, 48) + '%'),
          M('Red-tags this week', String(ri(r, 14, 34))),
        ],
        feed: feed([
          'Logged a red-tag finding, queued a quote for the estimator',
          'Moved a deficiency from quoted to scheduled repair',
          'Flagged a stalled finding sitting 9 days without a quote',
          'Closed a repair, recorded the conversion',
          'Reported weekly deficiency-to-revenue conversion',
        ]),
      };
    case 'dispatch_optimizer':
      return {
        metrics: [
          M('Jobs batched today', String(ri(r, 40, 80)), true),
          M('Windshield time cut', ri(r, 12, 26) + '%'),
          M('Underloaded days flagged', String(ri(r, 1, 5))),
        ],
        feed: feed([
          'Batched tomorrow\'s routes by geography and cert',
          'Flagged an underloaded Thursday for a South-side crew',
          'Protected an inspection route from a same-day add',
          'Rebalanced a double-booked tech',
          'Reported daily tech utilization',
        ]),
      };
    case 'emergency_triage':
      return {
        metrics: [
          M('After-hours calls (7d)', String(ri(r, 12, 24)), true),
          M('Avg triage-to-dispatch', ri(r, 4, 12) + ' min'),
          M('Escalated to on-call', String(ri(r, 6, 16))),
        ],
        feed: feed([
          'Triaged a 2am alarm, escalated to on-call, logged the incident',
          'Classified a low-severity call for next-day scheduling',
          'Paged the on-call chain for a pump failure',
          'Tied an incident to the customer account',
          'Logged an after-hours resolution',
        ]),
      };
    case 'quote_drafter':
      return {
        metrics: [
          M('Quotes pre-drafted (7d)', String(ri(r, 20, 45)), true),
          M('Avg draft time', ri(r, 3, 9) + ' min'),
          M('Sent within 24h', ri(r, 78, 94) + '%'),
        ],
        feed: feed([
          'Pre-built a repair quote the moment a deficiency landed',
          'Queued a scoped and priced proposal for estimator approval',
          'Pulled a comparable past job to set pricing',
          'Sent an approved quote to the customer inbox',
          'Flagged a quote waiting 2 days on approval',
        ]),
      };
    case 'bid_intel':
      return {
        metrics: [
          M('Bids drafted (30d)', String(ri(r, 12, 28)), true),
          M('Win rate tracked', ri(r, 32, 45) + '%'),
          M('Margin variance flagged', ri(r, 3, 9) + '%'),
        ],
        feed: feed([
          'Drafted scope and pricing from comparable past jobs',
          'Flagged a bid priced below the standard margin',
          'Logged a win, updated win rate by job type',
          'Pulled plan-review history for a new install bid',
          'Reported estimating consistency for the week',
        ]),
      };
    case 'compliance_watchdog':
      return {
        metrics: [
          M('Permit clocks watched', String(ri(r, 12, 28)), true),
          M('Jurisdictions tracked', String(ri(r, 8, 18))),
          M('Deadlines flagged (7d)', String(ri(r, 2, 8))),
        ],
        feed: feed([
          'Flagged a permit deadline in Riverton proper',
          'Loaded a county inspector\'s known preferences',
          'Caught a submittal due in 3 days',
          'Updated a code-cycle change for a jurisdiction',
          'Logged an AHJ acceptance-test window',
        ]),
      };
    case 'exec_dashboard':
      return {
        metrics: [
          M('Questions answered (7d)', String(ri(r, 30, 90)), true),
          M('Avg answer time', ri(r, 1, 4) + 's'),
          M('Reports refreshed today', String(ri(r, 4, 12))),
        ],
        feed: feed([
          'Answered "how much do they owe us" in real time',
          'Refreshed the cash-position rollup',
          'Flagged an AR spike over last month',
          'Pulled job profitability for a branch',
          'Logged a daily numbers snapshot',
        ]),
      };
    case 'location_command':
      return {
        metrics: [
          M('Branches rolled up', ri(r, 8, 9) + ' of 9', true),
          M('Variance flags (7d)', String(ri(r, 3, 10))),
          M('KPIs tracked / branch', String(ri(r, 6, 12))),
        ],
        feed: feed([
          'Rolled up nine branches to the same morning numbers',
          'Flagged a branch running below utilization target',
          'Surfaced a deficiency-conversion gap at one site',
          'Compared aging across all locations',
          'Logged the daily command snapshot',
        ]),
      };
    case 'knowledge_capture':
      return {
        metrics: [
          M('Operating rules captured', ri(r, 120, 340).toLocaleString('en-US'), true),
          M('Queries answered (7d)', String(ri(r, 30, 80))),
          M('Veterans shadowed', String(ri(r, 3, 9))),
        ],
        feed: feed([
          'Captured a dispatch quirk from a veteran into a searchable rule',
          'Answered a field question from past-job history',
          'Logged an AHJ contact only one person knew',
          'Turned a customer-history note into a rule',
          'Indexed a code reference for the field',
        ]),
      };
    case 'data_bridge':
      return {
        metrics: [
          M('Records synced (7d)', ri(r, 400, 1200).toLocaleString('en-US'), true),
          M('Re-typing removed', ri(r, 40, 80) + '%'),
          M('Mismatches flagged', String(ri(r, 2, 9))),
        ],
        feed: feed([
          'Synced a closed job from ServiceTrade to accounting',
          'Flagged a mismatch between two systems for review',
          'Pushed a status update into Teams automatically',
          'Removed a double-entry step for the office',
          'Reconciled a spreadsheet against the system of record',
        ]),
      };
    case 'onboarding_brain':
      return {
        metrics: [
          M('Field questions answered (7d)', String(ri(r, 40, 110)), true),
          M('New techs supported', String(ri(r, 3, 10))),
          M('Avg ramp cut', ri(r, 20, 40) + '%'),
        ],
        feed: feed([
          'Answered a new tech\'s on-site procedure question',
          'Pulled a code reference in the truck',
          'Walked a green tech through a past similar job',
          'Logged a recurring question for the training set',
          'Surfaced a safety step during a live job',
        ]),
      };
    case 'permit_hunter':
      return {
        metrics: [
          M('Permits caught (30d)', String(ri(r, 30, 70)), true),
          M('Timed to acceptance test', String(ri(r, 10, 28))),
          M('Owners identified', String(ri(r, 20, 55))),
        ],
        feed: feed([
          'Caught a new commercial sprinkler permit the day it posted',
          'Cross-referenced the AHJ and property manager',
          'Queued timed outreach for the acceptance-test window',
          'Flagged a large development coming out of the ground',
          'Logged a permit into the recurring pipeline',
        ]),
      };
    case 'territory_map':
      return {
        metrics: [
          M('Competitors mapped', ri(r, 120, 260).toLocaleString('en-US'), true),
          M('White-space metros', String(ri(r, 3, 8))),
          M('Route-density score', String(ri(r, 60, 92))),
        ],
        feed: feed([
          'Refreshed the SFMO license map for the Austin corridor',
          'Scored white-space in a thin-coverage metro',
          'Flagged a competitor cluster near an existing route',
          'Ranked expansion targets Riverton outward',
          'Logged a territory snapshot',
        ]),
      };
    case 'recurring_capture':
      return {
        metrics: [
          M('Recurring mix', ri(r, 34, 48) + '%', true),
          M('Installs flagged (30d)', String(ri(r, 18, 44))),
          M('Agreements drafted', String(ri(r, 10, 28))),
        ],
        feed: feed([
          'Flagged a completed install with no ITM agreement',
          'Drafted a recurring-contract offer for a one-off repair',
          'Converted a project client to a recurring agreement',
          'Updated the recurring-mix master metric',
          'Queued a follow-up on a stalled agreement',
        ]),
      };
    case 'acquisition_scout':
      return {
        metrics: [
          M('Targets shortlisted', String(ri(r, 12, 34)), true),
          M('Est. recurring books sized', String(ri(r, 8, 22))),
          M('New shops surfaced (30d)', String(ri(r, 4, 14))),
        ],
        feed: feed([
          'Surfaced a small inspection shop with a recurring book',
          'Sized a target\'s likely recurring revenue',
          'Ranked an acquisition target by route fit',
          'Flagged a shop that may be for sale',
          'Logged a target to the acquisition shortlist',
        ]),
      };
    case 'bid_watcher':
      return {
        metrics: [
          M('Bid boards watched', String(ri(r, 8, 18)), true),
          M('RFPs caught (30d)', String(ri(r, 6, 18))),
          M('Response scaffolds drafted', String(ri(r, 3, 10))),
        ],
        feed: feed([
          'Caught a school-district fire inspection RFP on the ESBD',
          'Drafted a response scaffold for a municipal contract',
          'Flagged a multi-year ISD bid closing this week',
          'Logged a city procurement posting',
          'Tracked a bid from posting to submission',
        ]),
      };
    default:
      return {
        metrics: [
          M('Items handled (7d)', String(ri(r, 20, 80)), true),
          M('In queue', String(ri(r, 4, 18))),
          M('Est. time saved (wk)', ri(r, 6, 22) + 'h'),
        ],
        feed: feed([
          'Handled a routing task and logged it to the shared brain',
          'Drafted an item and queued it for approval',
          'Closed an open item on the board',
          'Flagged an exception for a human to review',
          'Logged an update the rest of the OS can see',
        ]),
      };
  }
}

/**
 * ONE department dashboard feed. A department is a dashboard; the agents that serve it (founding +
 * harness-built) are its sub-dashboards. Returns the department identity, headline KPIs
 * (agent counts and skills) PLUS seed-derived sample KPIs, and the roster filtered
 * to this pillar (each agent carries one sample metric for its tile).
 */
router.get('/api/department/:pillar', (req, res) => {
  const pillar = String(req.params.pillar || '');
  const dept = DEPARTMENTS.find((d) => d.key === pillar);
  const agents = listAgents().filter((a) => (a.pillar_key || '') === pillar);
  const built = agents.filter((a) => a.origin === 'harness').length;
  const skills = agents.reduce((n, a) => n + (a.skill_count || 0), 0);

  // Headline numbers derived from the live roster (agent counts and skills).
  const realKpis = [
    { label: 'Agents live', value: String(agents.length), accent: false, sample: false as const },
    { label: 'Built by the Harness', value: String(built), accent: true, sample: false as const },
    { label: 'Skills across the team', value: String(skills), accent: false, sample: false as const },
  ];

  // Headline KPIs that show what this department reports.
  const sampleKpis = deptSampleKpis(pillar);

  const agentsOut = agents.map((a) => {
    const s = agentSample(a);
    return { ...a, sampleMetric: s.metrics[0] || null };
  });

  res.json({
    ok: true,
    pillar,
    name: dept?.name || (agents[0] && agents[0].pillar) || pillar,
    aiRole:
      dept?.aiRole ||
      'Every agent working this department, each running its own dashboard under one roof.',
    kpis: realKpis,
    sampleKpis,
    agents: agentsOut,
  });
});

/**
 * ONE agent sub-dashboard feed. Returns the agent (from the roster) plus its seed-derived
 * metrics and a short work-feed.
 */
router.get('/api/agent/:key', (req, res) => {
  const key = String(req.params.key || '');
  const agent = listAgents().find((a) => a.key === key);
  if (!agent) return res.status(404).json({ ok: false, error: 'No such agent.' });
  const s = agentSample(agent);
  res.json({ ok: true, agent, sampleMetrics: s.metrics, sampleFeed: s.feed });
});

export default router;
