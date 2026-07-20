/**
 * THE HIPPOCAMPUS — the operator brain's fire-protection operational knowledge.
 *
 * Structured and editable on purpose: this file IS the depth that separates
 * "McKinsey operator who's run a fire shop" from "generic chatbot." Deepen it over
 * time; swap it per vertical (mechanical contracting, electrical, ...) to re-target
 * the whole consult. Nothing here is buried in a prompt string — the prompt is
 * assembled from these structures at call time.
 *
 * SAFETY PRINCIPLE (enforced in the prompt): this knowledge generates QUESTIONS and
 * pattern-recognition, never asserted claims about the client's numbers.
 */

/** Core value chains — where the money flows and where it stalls. */
export const WORKFLOWS = [
  {
    name: 'Inspection → cash',
    chain: 'agreement → scheduled inspection → tech on site → deficiency found → quote → approval → repair → invoice → collect',
    stalls: [
      'deficiency sits unquoted (every day of lag kills conversion — sub-24h quotes convert 2–3× vs week-old)',
      'quote queues behind one estimator',
      'approved repair waits for scheduling',
      'completed job waits days to invoice (manual invoicing adds 15–30 days of DSO)',
      'invoice ages with nobody chasing it (~60% of contractor invoices pay late)',
    ],
  },
  {
    name: 'Emergency / on-call dispatch',
    chain: 'alarm sounding / active leak / pump failure → line answered → severity triage → name+number+address → on-call escalation → tech rolls → incident logged',
    stalls: [
      'after-hours call handling depends on who happens to answer',
      'on-call chain is informal (a cell phone, a group text)',
      'no incident log tied to the account afterward',
    ],
    note: 'The most operationally and reputationally loaded flow in the business — a mishandled 2am alarm call loses a customer forever. Treat with weight.',
  },
  {
    name: 'Bid / estimate',
    chain: 'lead → site visit → takeoff/scope → price → proposal out → follow-up → win/lose',
    stalls: [
      'estimate turnaround measured in weeks',
      'no win-rate tracking by job type',
      'inconsistent pricing between estimators (5–10% margin leakage)',
      'quiet leads never followed up',
    ],
  },
  {
    name: 'Permit / AHJ compliance',
    chain: 'project sold → plans → permit application → AHJ review → inspections → sign-off → closeout docs',
    stalls: [
      'each jurisdiction has its own quirks, living in one PM\'s head',
      'permit clocks tracked on memory and sticky notes',
      'closeout docs chased after the fact',
    ],
  },
  {
    name: 'Receivables',
    chain: 'job complete → invoice → aging → reminder → escalation → payment',
    stalls: [
      'collections is someone\'s second job',
      'the total-outstanding number takes days to produce',
      'reminders are ad-hoc and awkward (relationship-first companies hate chasing)',
    ],
  },
];

/** Leak archetypes — patterns the operator recognizes instantly from half a sentence. */
export const LEAK_ARCHETYPES = [
  { key: 'quote_lag', smell: 'quotes take days/weeks; everything waits on one estimator', probe: 'When a deficiency is found on a Tuesday, what date does the customer actually see a price?' },
  { key: 'informal_deficiency', smell: 'deficiencies handled by memory, follow-up "when we get to it"', probe: 'Of ten deficiencies your techs write up, how many become paid repairs — and who counts?' },
  { key: 'spof_veteran', smell: 'one person "just knows" — dispatcher, estimator, permit PM', probe: 'If that person took two weeks off with no phone, what breaks on day three?' },
  { key: 'number_latency', smell: 'decisions made on month-old numbers; reports take days to pull', probe: 'What number do you wish you saw every morning that you currently see monthly?' },
  { key: 'retyping', smell: 'data re-keyed between ServiceTrade / spreadsheets / accounting', probe: 'How many times does one completed job get typed into something by a human?' },
  { key: 'branch_variance', smell: 'every location does it their own way; no side-by-side', probe: 'Which branch runs it best — and would the other branch managers agree?' },
  { key: 'renewal_leak', smell: 'agreements lapse silently; nobody owns renewals', probe: 'Who gets told when an inspection agreement quietly doesn\'t renew — anyone?' },
  { key: 'afterhours_roulette', smell: 'after-hours calls roll to a cell / answering service', probe: 'Walk me through last month\'s worst 2am call — what actually happened, minute by minute?' },
];

/** Veteran-dependency archetypes — where tribal knowledge concentrates in a fire shop. */
export const VETERAN_ARCHETYPES = [
  'the dispatcher who holds the whole schedule in her head',
  'the estimator every quote routes through',
  'the one PM who knows every AHJ\'s quirks in every city',
  'the ops manager every complaint lands on',
  'the office manager who is secretly the integration layer between every system',
];

/** Operational fingerprints of THIS company (from the real routing brain) — recognize, never assert. */
export const FINGERPRINTS = [
  'A named partner routes always-to-voicemail, never transferred (doesn\'t take cold calls).',
  'Complaints bypass everything, straight to the Operations Manager — never handled by the front desk.',
  'Spanish-only callers are helped in Spanish but not transferred — captured for a bilingual callback.',
  'Emergencies pre-empt all routing: name, number, address, then the after-hours on-call queue.',
  'Multi-location (9 sites, San Antonio HQ) — expect per-branch variance in every workflow.',
];

/** Standard systems the operator expects to find (and their classic gaps). */
export const SYSTEMS_KNOWLEDGE = [
  { name: 'ServiceTrade / Inspect Point / BuildOps', role: 'field service system of record', gap: 'completions don\'t trigger reviews, collections, or renewals by themselves' },
  { name: 'QuickBooks / accounting package', role: 'the money', gap: 'lives an island away from the field system — humans bridge it' },
  { name: 'Teams / M365', role: 'coordination', gap: 'decisions and call outcomes die in chat threads' },
  { name: 'Spreadsheets', role: 'the real integration layer', gap: 'nine local versions of the truth, re-keyed by hand' },
];

/** Consultant frameworks — the neocortex lenses, applied to every answer. */
export const FRAMEWORKS = [
  'Trace the value chain: trigger → cash. The stall points are the build sites.',
  'Find the constraint: one bottleneck governs each flow — name the person or step.',
  'Cost of delay beats cost of labor: a week-old quote loses more than the estimator\'s salary.',
  'Single point of failure: any process living in one head is a risk AND a capture target.',
  'Number latency: how old is the number he decides on? Anything monthly should be daily.',
  'Ask what an AI operating system would take over FIRST in this department — smallest change, biggest relief.',
];

/** Render the hippocampus as compact prompt context. */
export function knowledgeContext(departmentKey?: string): string {
  const parts: string[] = [];
  parts.push('VALUE CHAINS & WHERE THEY STALL:');
  for (const w of WORKFLOWS) parts.push(`- ${w.name}: ${w.chain}\n  stalls: ${w.stalls.join('; ')}${w.note ? `\n  NOTE: ${w.note}` : ''}`);
  parts.push('\nLEAK ARCHETYPES (recognize from half a sentence; each has a probe question):');
  for (const l of LEAK_ARCHETYPES) parts.push(`- ${l.key}: "${l.smell}" → probe: "${l.probe}"`);
  parts.push('\nVETERAN-DEPENDENCY ARCHETYPES: ' + VETERAN_ARCHETYPES.join('; '));
  parts.push('\nTHIS COMPANY\'S OPERATIONAL FINGERPRINTS (recognize, never assert as fact):');
  for (const f of FINGERPRINTS) parts.push(`- ${f}`);
  parts.push('\nSYSTEMS YOU EXPECT TO FIND: ' + SYSTEMS_KNOWLEDGE.map((s) => `${s.name} (${s.role}; classic gap: ${s.gap})`).join(' · '));
  parts.push('\nCONSULTANT LENSES (apply to every answer):');
  for (const f of FRAMEWORKS) parts.push(`- ${f}`);
  return parts.join('\n');
}
