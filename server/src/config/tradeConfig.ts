/**
 * TRADE_CONFIG — the one trade-agnostic knob box for the cross-industry agents.
 * Fire protection is the first tenant, not the only one: takeoff units + rate card
 * (Estimator), the follow-up cadence (Closer), default plan intervals (Service plans)
 * and the crew/skill taxonomy (Dispatcher) all live here, never hardcoded in an engine.
 * Swap this object → new trade, same engines.
 */
export interface RateCardItem {
  /** the takeoff item label this priced from */
  match: string;
  /** how it reads on the quote (may differ from the takeoff label) */
  quoteLabel: string;
  unit: string;
  /** dollars per unit (waste-inclusive) */
  rate: number;
  /** labour hours per unit */
  laborHrs: number;
}

export interface TradeConfig {
  estimating: {
    rateCardYear: number;
    wasteFactorPct: number; // shown in the quote note; baked into the unit rates
    laborRate: number; // $/hr
    /** items below this confidence are flagged for a human and left OUT of the priced quote */
    confidenceThreshold: number;
    rateCard: RateCardItem[];
  };
  /** The Closer's follow-up cadence — engine logic, not a prompt. */
  closer: {
    cadence: { tier: string; dayFrom: number; label: string }[];
    /** after this many days with no book, a quote is marked stalled and handed back to a human */
    stalledAfterDays: number;
  };
  /** Service-plan defaults. */
  plans: {
    defaultIntervals: { annual: number; semiannual: number; quarterly: number };
    renewSoonDays: number; // counts as "lapsing"
    renewUrgentDays: number; // money-coloured, draft the renewal now
  };
  /** The Dispatcher's crew/skill taxonomy + scoring weights — engine logic, not a prompt. */
  dispatch: {
    /** the skill vocabulary a crew can carry and a job can require */
    skills: string[];
    /** default job window length, hours */
    slotHours: number;
    /** a crew at/above this daily load counts as full (money-coloured) */
    fullLoadPct: number;
    /** reminders per appointment, hours before the window */
    reminderHoursBefore: number[];
    /** weights the match score sums — skill fit dominates, then zone, then spare capacity */
    scoring: { skill: number; zone: number; capacity: number };
  };
}

export const TRADE_CONFIG: TradeConfig = {
  estimating: {
    rateCardYear: 2026,
    wasteFactorPct: 6,
    laborRate: 86,
    confidenceThreshold: 0.85,
    rateCard: [
      { match: 'Sprinkler heads', quoteLabel: 'Sprinkler heads', unit: 'heads', rate: 38, laborHrs: 0.25 },
      { match: 'Extinguishers', quoteLabel: 'Extinguishers', unit: 'units', rate: 64, laborHrs: 0.15 },
      { match: 'Backflow assemblies', quoteLabel: 'Backflow tests', unit: 'assemblies', rate: 310, laborHrs: 0.5 },
      { match: 'Ceiling drops', quoteLabel: 'Ceiling drops', unit: 'drops', rate: 74, laborHrs: 0.3 },
      { match: 'Hood suppression', quoteLabel: 'Hood suppression', unit: 'system', rate: 2400, laborHrs: 6 },
    ],
  },
  closer: {
    // day 1 a nudge, day 3 the value, day 7 last call, then stalled.
    cadence: [
      { tier: 'nudge', dayFrom: 1, label: 'nudge sent' },
      { tier: 'value', dayFrom: 3, label: 'value sent' },
      { tier: 'last_call', dayFrom: 7, label: 'last call' },
    ],
    stalledAfterDays: 10,
  },
  plans: {
    defaultIntervals: { annual: 365, semiannual: 180, quarterly: 90 },
    renewSoonDays: 30,
    renewUrgentDays: 14,
  },
  dispatch: {
    skills: ['sprinkler', 'backflow', 'extinguisher', 'alarm', 'hood', 'clearance'],
    slotHours: 4,
    fullLoadPct: 90,
    reminderHoursBefore: [48, 4], // 48 hours out, then the morning of
    scoring: { skill: 3, zone: 2, capacity: 1 },
  },
};

export function rateFor(itemLabel: string): RateCardItem | undefined {
  return TRADE_CONFIG.estimating.rateCard.find((r) => r.match === itemLabel);
}
