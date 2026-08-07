/**
 * THE CAPABILITY CATALOG — what this operating system can build.
 *
 * This is the "anything is possible" layer of The Operator (audit agent). When the CEO
 * describes a pain, the brain matches it against this catalog and the fix blooms on the
 * pillar map — their specific pain connected to a specific, buildable AI employee.
 *
 * `live: true` marks capabilities ALREADY RUNNING in this OS (the proof in the room).
 * `triggers` are keyword regexes for the deterministic (keyless) matcher — the audit
 * must land the moment even on a boot with no LLM key.
 */

export interface CapabilityDef {
  id: string;
  name: string;
  what: string; // one-line pitch, spoken in the room
  builds: string; // what we concretely ship
  pillars: string[]; // pillar keys this attaches to
  live?: boolean; // already running in this OS today
  triggers: string[]; // regex fragments for keyword matching (case-insensitive)
}

export const CAPABILITIES: CapabilityDef[] = [
  {
    id: 'ai_receptionist',
    name: 'AI Receptionist',
    what: 'Answers every line 24/7, classifies the call, routes it, captures the lead.',
    builds: 'Voice agent on your numbers with your real routing brain — already answering in this OS.',
    pillars: ['reception', 'service'],
    live: true,
    triggers: ['phone', 'call', 'answer', 'front desk', 'reception', 'after.?hours', 'miss(ed|ing) calls?', 'voicemail', 'spanish'],
  },
  {
    id: 'invoice_chaser',
    name: 'Invoice Collector',
    what: 'Watches every receivable age and drafts the friendly→firm nudge before you think of it.',
    builds: 'Aging tracker + reminder drafter with human approval — already collecting in this OS.',
    pillars: ['finance'],
    live: true,
    triggers: ['invoice', 'receivab', 'collect', 'owe', 'past due', 'aging', 'dso', 'paid late', 'cash ?flow', 'billing'],
  },
  {
    id: 'review_engine',
    name: 'Review Collector',
    what: 'Turns every completed job into a Google review and drafts the on-brand reply.',
    builds: 'Job-completion → review request pipeline + reply drafting — already running in this OS.',
    pillars: ['reception', 'sales'],
    live: true,
    triggers: ['review', 'reputation', 'google', 'word of mouth', 'referral'],
  },
  {
    id: 'quote_drafter',
    name: 'Deficiency Quote Drafter',
    what: 'Pre-builds 80% of the repair quote the moment the deficiency is logged — quotes out in 24h convert 2–3× better than week-old ones.',
    builds: 'Agent that reads the inspection deficiency, drafts the scoped/priced proposal, queues it for the estimator to approve.',
    pillars: ['sales', 'inspections'],
    triggers: ['quote', 'estimat', 'proposal', 'bid', 'deficienc', 'pricing', 'takes? (a|one) week', 'queue'],
  },
  {
    id: 'deficiency_pipeline',
    name: 'Deficiency-to-Revenue Pipeline',
    what: 'Systematic deficiency management converts 30–50% of findings into paid repair work; informal handling leaves that revenue on the table.',
    builds: 'Tracker that catches every red-tag finding, drives quote → approval → scheduled repair, and reports the conversion rate.',
    pillars: ['inspections', 'service', 'sales'],
    triggers: ['deficien', 'red.?tag', 'finding', 'repair (work|revenue)', 'follow.?up', 'fell? through', 'slip', 'crack'],
  },
  {
    id: 'renewal_guardian',
    name: 'Renewal Guardian',
    what: 'Inspection agreements are the recurring heartbeat — this agent never lets one lapse silently.',
    builds: 'Watches every ITM contract cadence (NFPA 25/72/10/96), flags upcoming renewals and unscheduled inspections, drafts the renewal outreach.',
    pillars: ['inspections', 'sales'],
    triggers: ['renewal', 'contract', 'agreement', 'recurring', 'lapse', 'annual inspection', 'due', 'expir'],
  },
  {
    id: 'knowledge_capture',
    name: 'Veteran Knowledge Capture',
    what: 'The stuff only one person knows becomes the company brain — captured in-flow, not in a binder.',
    builds: 'Memory agent that interviews and shadows your veterans (dispatch quirks, AHJ contacts, customer history) into searchable operating rules.',
    pillars: ['ops', 'hr'],
    triggers: ['in (his|her|their) head', 'only (one|person|guy|gal)', 'tribal', 'retir', 'knows every', 'if (he|she|they) le(ft|aves)', 'veteran', 'institutional'],
  },
  {
    id: 'dispatch_optimizer',
    name: 'Dispatch Optimizer',
    what: 'Techs are the most expensive resource — utilization and windshield time decide the P&L.',
    builds: 'Scheduling agent that batches jobs by geography and cert, protects inspection routes, and flags underloaded days.',
    pillars: ['service', 'inspections'],
    triggers: ['dispatch', 'schedul', 'route', 'routing', 'windshield', 'drive time', 'utilization', 'double.?book', 'truck'],
  },
  {
    id: 'compliance_watchdog',
    name: 'AHJ Compliance Watchdog',
    what: 'Every jurisdiction has its own rules — this agent knows each AHJ\'s quirks so compliance stops living in one person\'s head.',
    builds: 'Per-jurisdiction knowledge base (permit rules, inspector preferences, code cycles) + deadline watcher across all locations.',
    pillars: ['projects'],
    triggers: ['ahj', 'jurisdiction', 'city', 'county', 'fire marshal', 'permit', 'code', 'nfpa', 'inspector prefer', 'deadline'],
  },
  {
    id: 'data_bridge',
    name: 'System Data Bridge',
    what: 'Every place a human re-types data from one system into another is a leak an agent closes.',
    builds: 'Integration agents between your systems of record (ServiceTrade ↔ accounting ↔ Teams ↔ spreadsheets) — one entry, everywhere.',
    pillars: ['finance', 'projects', 'inspections'],
    triggers: ['spreadsheet', 'excel', 're.?(type|enter|key)', 'manual(ly)? (enter|input|move|copy)', 'copy.?paste', 'doesn.?t talk', 'export', 'double entry', 'two systems'],
  },
  {
    id: 'location_command',
    name: 'Multi-Location Command',
    what: 'Nine branches, one brain — see every location\'s numbers side by side instead of nine versions of the truth.',
    builds: 'Cross-location rollup: same KPIs per branch (revenue, aging, utilization, deficiency conversion), variance flagged automatically.',
    pillars: ['ops', 'finance'],
    triggers: ['location', 'branch', 'office', 'austin|millbrook|fairview|lakeside|lubbock|college station|houston|corpus', 'their own way', 'each (site|branch|office)', 'consolidat', 'roll.?up'],
  },
  {
    id: 'exec_dashboard',
    name: 'Executive Numbers Agent',
    what: 'If it takes days to answer "how much do they owe us?", the answer is an agent, not a meeting.',
    builds: 'Always-current command dashboard + ask-anything interface over the company\'s live numbers.',
    pillars: ['finance', 'ops'],
    triggers: ['report', 'dashboard', 'kpi', 'numbers', 'how much', 'end of (the )?month', 'visibility', 'don.?t know until'],
  },
  {
    id: 'emergency_triage',
    name: 'After-Hours Emergency Triage',
    what: 'Alarm going off at 2am gets triaged, routed to on-call, and logged before a human even wakes up.',
    builds: 'Emergency line agent: severity triage, on-call escalation into Teams, incident log tied to the account.',
    pillars: ['service'],
    triggers: ['emergency', 'after.?hours', 'on.?call', 'alarm going', '2 ?am', 'night', 'weekend'],
  },
  {
    id: 'bid_intel',
    name: 'Bid & Estimate Intelligence',
    what: 'Inconsistent quoting costs 5–10% of margin — standardized, history-aware estimating stops the bleed.',
    builds: 'Estimating copilot: pulls comparable past jobs, drafts scope + pricing to your standards, tracks win rate by type.',
    pillars: ['sales'],
    triggers: ['margin', 'win rate', 'lost (the )?bid', 'underbid', 'price[ds]? (it|too)', 'consistent', 'plan review', 'design'],
  },
  {
    id: 'onboarding_brain',
    name: 'Tech Onboarding Brain',
    what: 'New techs ramp in weeks, not years, when the company\'s knowledge is queryable in the truck.',
    builds: 'Field assistant trained on your procedures, past jobs, and code references — answers on-site questions instantly.',
    pillars: ['hr', 'service'],
    triggers: ['new (tech|hire|guy)', 'training', 'onboard', 'ramp', 'shortage', 'hiring', 'green', 'apprentice'],
  },
  {
    id: 'permit_hunter',
    name: 'Permit-to-ITM Hunter',
    what: 'Every new commercial building is a code-mandated future inspection account — this catches the permit and times the pitch to the acceptance test.',
    builds: 'Agent that watches city/county permit portals for fire sprinkler/alarm permits, cross-references the AHJ and the owner/property manager, and queues timed outreach at the acceptance-test / first-annual window.',
    pillars: ['growth', 'sales'],
    triggers: ['permit', 'new construction', 'new building', 'developer', 'general contractor', '\\bgc\\b', 'ground.?break', 'acceptance test', 'coming out of the ground'],
  },
  {
    id: 'territory_map',
    name: 'Texas Territory Map',
    what: 'Maps every state-licensed fire contractor and the metros where coverage is thin — so you expand into white space instead of a knife fight.',
    builds: 'Pulls the Texas SFMO public license database into a live competitor map by metro; scores white-space and route-density opportunity Riverton → Austin → Houston/DFW.',
    pillars: ['growth', 'ops'],
    triggers: ['expand', 'expansion', 'territory', 'market share', 'competitor', 'white ?space', 'new (market|metro)', 'take over (texas|the)', 'grow(th|ing)? (into|across)'],
  },
  {
    id: 'recurring_capture',
    name: 'Recurring-Revenue Capture',
    what: 'Recurring ITM is what raises the whole company\'s value — operators at 40%+ recurring trade 2–3 EBITDA turns higher — so every install and one-off should become an agreement.',
    builds: 'Agent that flags every completed install / one-off repair with no ITM agreement, drafts the recurring-contract offer, and tracks recurring-mix % as the master growth metric.',
    pillars: ['growth', 'inspections', 'finance'],
    triggers: ['recurring', 'agreement', 'one.?off', 'project only', 'contract mix', 'monthly revenue', '\\brmr\\b', 'retention', 'churn', 'recurring mix'],
  },
  {
    id: 'acquisition_scout',
    name: 'Acquisition Scout',
    what: 'The market is fragmented and consolidating fast — a small shop with an inspection book is a portable recurring-revenue asset. Buy the route before a national does.',
    builds: 'Uses the SFMO license database to surface small independent fire shops by metro, sizes their likely recurring book, and builds a ranked acquisition-target shortlist.',
    pillars: ['growth'],
    triggers: ['acqui', 'buy (a|out)', 'tuck.?in', 'roll.?up', 'consolidat', 'small shop', 'for sale', 'merger'],
  },
  {
    id: 'bid_watcher',
    name: 'Bid Board Watcher',
    what: 'School districts and cities must competitively bid fire inspection work — miss the posting and you miss a multi-year contract.',
    builds: 'Agent that watches ISD / municipal bid boards and the state ESBD for fire inspection & alarm RFPs, and drafts the response scaffold.',
    pillars: ['growth', 'sales'],
    triggers: ['\\bbid board\\b', '\\brfp\\b', 'request for proposal', 'school district', '\\bisd\\b', 'municipal', 'city contract', 'government (work|bid)', 'esbd', 'procurement'],
  },
];

export function capabilityById(id: string): CapabilityDef | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}
