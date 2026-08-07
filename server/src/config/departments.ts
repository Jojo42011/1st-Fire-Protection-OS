/**
 * THE DEPARTMENT MODEL, the real Northstar org, extracted from the live receptionist
 * routing prompt (who calls actually route to). This is founder-layer knowledge:
 * swap this file to re-target the wheel at a different company.
 *
 * Each department carries everything the audit needs:
 *  - wheel identity (name, tagline)
 *  - what its AI department DOES (plain language, never techy)
 *  - the composable agents that make it up, each with a build-time estimate
 *  - which departments/systems it connects to (the nervous-system lines)
 *  - the consulting question deck: one at a time, each with comfort-rail chips
 *    (common answers as a starting rail, the open answer is always the real path)
 */

export interface DeptAgent {
  name: string;
  what: string; // one plain sentence
  capability_id?: string; // link into the capability catalog (live flag, matching)
  weeks: number; // honest build estimate
  live?: boolean; // already running in this OS
}

export interface DeptQuestion {
  q: string;
  chips: string[]; // comfort rail, common answers, never the only path
}

export interface DepartmentDef {
  key: string;
  name: string;
  wheel: string; // short label on the wheel
  tagline: string;
  aiRole: string; // what this department's AI does, in the CEO's language
  agents: DeptAgent[];
  connects: string[]; // other department keys
  systems: string[];
  questions: DeptQuestion[];
}

export const DEPARTMENTS: DepartmentDef[] = [
  {
    key: 'inspections',
    name: 'Inspections',
    wheel: 'Inspections',
    tagline: 'Annual sprinkler, extinguisher, backflow, alarm, the recurring-revenue heartbeat',
    aiRole: 'Watches every agreement, schedules the cadence, and turns every deficiency into a quoted repair, automatically.',
    agents: [
      { name: 'Renewal Guardian', what: 'Never lets an inspection agreement quietly lapse', capability_id: 'renewal_guardian', weeks: 2 },
      { name: 'Deficiency Pipeline', what: 'Every finding tracked from red-tag to paid repair', capability_id: 'deficiency_pipeline', weeks: 3 },
      { name: 'Inspection Router', what: 'Builds the inspection calendar by geography and cert', capability_id: 'dispatch_optimizer', weeks: 2 },
    ],
    connects: ['service', 'sales', 'projects'],
    systems: ['ServiceTrade'],
    questions: [
      { q: 'How many active inspection agreements are on the books, and who notices when one quietly lapses?', chips: ['A few hundred', 'Over a thousand', 'Nobody tracks lapses'] },
      { q: 'When a tech finds a deficiency on site, how many days until a quote reaches the customer?', chips: ['Same day', '2-3 days', 'A week or more'] },
      { q: 'Who schedules the inspections, and what breaks when they are out?', chips: ['One coordinator holds it all', 'A shared calendar', 'Each branch does its own'] },
    ],
  },
  {
    key: 'service',
    name: 'Service & Repair',
    wheel: 'Service & Repair',
    tagline: 'Sprinkler, alarm, extinguisher, pump service, plus the 2am emergency path',
    aiRole: 'Triages every call by severity, routes the on-call chain, and keeps techs on billable work instead of windshield time.',
    agents: [
      { name: 'Emergency Triage', what: 'The 2am alarm gets triaged, escalated, and logged before anyone wakes up', capability_id: 'emergency_triage', weeks: 2 },
      { name: 'Dispatch Optimizer', what: 'Batches jobs by geography and cert; flags underloaded days', capability_id: 'dispatch_optimizer', weeks: 3 },
      { name: 'Service Intake', what: 'Every service call answered, classified, and routed', capability_id: 'ai_receptionist', weeks: 0, live: true },
    ],
    connects: ['inspections', 'ops', 'reception'],
    systems: ['ServiceTrade', 'Microsoft Teams'],
    questions: [
      { q: 'Walk me through an after-hours emergency, alarm going off at 2am. What actually happens?', chips: ['Answering service pages on-call', 'Rolls to a cell phone', 'Depends who answers'] },
      { q: 'How many billable hours per tech per day, and how much of it is windshield time?', chips: ['Six or more billable', 'Four to five', 'We do not measure it'] },
      { q: 'How do emergency calls get prioritized against scheduled work?', chips: ['Dispatcher judgment', 'First come first served', 'Squeaky wheel gets the truck'] },
    ],
  },
  {
    key: 'sales',
    name: 'Sales & Estimating',
    wheel: 'Sales & Estimating',
    tagline: 'New installs, contracts, estimates, the front end of everything',
    aiRole: 'Drafts 80% of every quote the day the need appears, tracks win rate by job type, and never lets a warm lead go cold.',
    agents: [
      { name: 'Quote Drafter', what: 'Pre-builds the repair quote the moment the deficiency lands', capability_id: 'quote_drafter', weeks: 2 },
      { name: 'Bid Intelligence', what: 'Pulls comparable past jobs; drafts scope and price to your standard', capability_id: 'bid_intel', weeks: 3 },
      { name: 'Lead Capture', what: 'Every inbound opportunity logged with name, need, and callback', capability_id: 'ai_receptionist', weeks: 0, live: true },
    ],
    connects: ['inspections', 'projects', 'finance'],
    systems: ['ServiceTrade'],
    questions: [
      { q: 'How long does an estimate take from site visit to the customer inbox, and who is it waiting on?', chips: ['Under 48 hours', 'About a week', 'Depends on the estimator'] },
      { q: 'Do you know your win rate by job type?', chips: ['We track it closely', 'Rough gut number', 'No idea'] },
      { q: 'Where do new leads come from, and does anyone follow up on the quiet ones?', chips: ['Word of mouth', 'Referrals and repeats', 'Follow-up is spotty'] },
    ],
  },
  {
    key: 'projects',
    name: 'Project Management',
    wheel: 'Projects & Permits',
    tagline: 'Runs the build after the sale, and owns permits & AHJ compliance',
    aiRole: 'Tracks every job from sold to closed, watches permit clocks in every jurisdiction, and carries each AHJ\'s quirks so no one person has to.',
    agents: [
      { name: 'Permit Pilot', what: 'Per-jurisdiction rules, deadlines, and inspector preferences, watched automatically', capability_id: 'compliance_watchdog', weeks: 3 },
      { name: 'Project Tracker', what: 'Milestones, submittals, and closeout docs, visible at a glance', weeks: 3 },
      { name: 'Data Bridge', what: 'One entry, everywhere, no re-typing between systems', capability_id: 'data_bridge', weeks: 2 },
    ],
    connects: ['sales', 'finance', 'vendors'],
    systems: ['ServiceTrade', 'Spreadsheets'],
    questions: [
      { q: 'Which jurisdictions slow you down the most, and who carries each AHJ\'s quirks in their head?', chips: ['Riverton proper', 'The smaller counties', 'One PM knows them all'] },
      { q: 'How do you track a project from sold to closed, a system or a spreadsheet?', chips: ['ServiceTrade', 'Spreadsheets', 'A bit of both'] },
      { q: 'What is the most common reason a project slips?', chips: ['Permits', 'Material lead times', 'Crew availability'] },
    ],
  },
  {
    key: 'finance',
    name: 'Finance & Accounting',
    wheel: 'Finance',
    tagline: 'Billing · Accounts Payable · Accounts Receivable',
    aiRole: 'Invoices the day the job closes, chases every receivable on a friendly-to-firm cadence, and answers "how much do they owe us" instantly.',
    agents: [
      { name: 'Invoice Collector', what: 'Watches aging, drafts the nudge, waits for your approve', capability_id: 'invoice_chaser', weeks: 0, live: true },
      { name: 'AP Assistant', what: 'Codes vendor bills, flags duplicates, preps the pay run', weeks: 2 },
      { name: 'Numbers Agent', what: 'The always-current answer to any money question', capability_id: 'exec_dashboard', weeks: 2 },
    ],
    connects: ['sales', 'projects', 'ops'],
    systems: ['ServiceTrade', 'Spreadsheets'],
    questions: [
      { q: 'What is total outstanding AR right now, and how long would it take to get that exact number?', chips: ['I know it today', 'By end of month', 'Days, someone would pull it'] },
      { q: 'How many days from job-complete to invoice-sent?', chips: ['Same week', 'Two weeks or more', 'Varies by branch'] },
      { q: 'Who chases the money, is collections someone\'s actual job?', chips: ['A dedicated person', 'Office manager\'s side job', 'Whoever has time'] },
    ],
  },
  {
    key: 'hr',
    name: 'Human Resources',
    wheel: 'HR & Recruiting',
    tagline: 'Hiring, onboarding, certs, field crews across nine locations',
    aiRole: 'Screens candidates the day they apply, ramps new techs with the company\'s knowledge in their pocket, and never lets a license lapse.',
    agents: [
      { name: 'Recruiting Screen', what: 'Posts, screens, and schedules interviews for hard-to-fill roles', weeks: 2 },
      { name: 'Onboarding Brain', what: 'New techs ask it anything, procedures, past jobs, code references', capability_id: 'onboarding_brain', weeks: 3 },
      { name: 'Cert Tracker', what: 'Licenses and renewals watched across all nine sites', weeks: 1 },
    ],
    connects: ['ops'],
    systems: ['Microsoft 365'],
    questions: [
      { q: 'How long before a green tech runs jobs solo, and what would cut that in half?', chips: ['A few months', 'A year or more', 'Depends who trains them'] },
      { q: 'Who tracks licenses and certs across nine locations?', chips: ['HR has a sheet', 'Each branch manager', 'Caught at renewal time'] },
      { q: 'What role is hardest to hire right now?', chips: ['Sprinkler fitters', 'Alarm techs', 'Inspectors'] },
    ],
  },
  {
    key: 'ops',
    name: 'Operations',
    wheel: 'Operations',
    tagline: 'Escalations, quality, the catch-all, where every complaint lands today',
    aiRole: 'Catches every escalation before it reaches a human, shows every branch side-by-side each morning, and captures what the veterans know.',
    agents: [
      { name: 'Escalation Desk', what: 'Complaints routed, tracked, and closed, off the Ops Manager\'s back', weeks: 2 },
      { name: 'Command Dashboard', what: 'Nine branches, same numbers, every morning', capability_id: 'location_command', weeks: 2 },
      { name: 'Knowledge Capture', what: 'What only the veterans know becomes the company brain', capability_id: 'knowledge_capture', weeks: 3 },
    ],
    connects: ['service', 'finance', 'hr', 'reception'],
    systems: ['Microsoft Teams'],
    questions: [
      { q: 'Every complaint lands on the Operations Manager today. How many a week, and how many share a root cause?', chips: ['A handful', 'Daily occurrence', 'Nobody counts'] },
      { q: 'What number do you wish you saw every morning that you currently get monthly?', chips: ['Cash position', 'Branch performance', 'Job profitability'] },
      { q: 'If your best ops person left tomorrow, what breaks first?', chips: ['Scheduling', 'Customer relationships', 'Everything'] },
    ],
  },
  {
    key: 'vendors',
    name: 'Vendors & Procurement',
    wheel: 'Vendors',
    tagline: 'Supplier calls, pricing, purchase orders',
    aiRole: 'Triages every supplier call, tracks quotes and POs, and flags the price creep no one catches.',
    agents: [
      { name: 'Vendor Desk', what: 'Supplier calls answered, logged, and routed', weeks: 2 },
      { name: 'Price Watch', what: 'Flags cost creep across suppliers before it hits margin', weeks: 2 },
    ],
    connects: ['projects', 'finance'],
    systems: ['ServiceTrade'],
    questions: [
      { q: 'Who owns vendor relationships and pricing today?', chips: ['One person owns it', 'Each PM buys their own', 'Office manager juggles it'] },
      { q: 'Would you know if a supplier\'s pricing crept up five percent?', chips: ['We catch it eventually', 'Only on big items', 'Not really'] },
    ],
  },
  {
    key: 'reception',
    name: 'Reception',
    wheel: 'Front Desk',
    tagline: 'The general line, every call classified, routed, captured',
    aiRole: 'Answers 24/7 in English and Spanish, routes by the real routing brain, and never lets a message die on a sticky note.',
    agents: [
      { name: 'AI Receptionist', what: 'Answering the Riverton line right now, in this OS', capability_id: 'ai_receptionist', weeks: 0, live: true },
      { name: 'Message Router', what: 'Every message logged, routed, and followed up', weeks: 1 },
      { name: 'Review Engine', what: 'Every finished job becomes a Google review', capability_id: 'review_engine', weeks: 0, live: true },
    ],
    connects: ['service', 'sales', 'finance', 'ops'],
    systems: ['Vapi + Twilio (this OS)'],
    questions: [
      { q: 'How many calls a day hit the front desk, and how many end as a sticky note?', chips: ['Dozens', 'Hundreds', 'No one has counted'] },
      { q: 'What happens to a message for someone who is out in the field?', chips: ['Teams ping', 'Sticky note', 'Voicemail roulette'] },
    ],
  },
  {
    key: 'growth',
    name: 'Growth & Market Expansion',
    wheel: 'Growth',
    tagline: 'Winning recurring ITM across Texas - permits to pipeline to acquisition',
    aiRole: 'Hunts future recurring-inspection revenue across Texas: catches new-construction permits before the acceptance test, maps competitor white-space from the state license database, converts installs into recurring agreements, and sources tuck-in shops - density first, Riverton outward.',
    agents: [
      { name: 'Permit Hunter', what: 'Catches new commercial fire-system permits the day they post and times outreach to the acceptance test', capability_id: 'permit_hunter', weeks: 3 },
      { name: 'Territory Mapper', what: 'Maps every state-licensed competitor and the metros where coverage is thin', capability_id: 'territory_map', weeks: 3 },
      { name: 'Recurring Capture', what: 'Turns every new install and one-off repair into a recurring ITM agreement', capability_id: 'recurring_capture', weeks: 2 },
      { name: 'Acquisition Scout', what: 'Surfaces small inspection shops worth acquiring for their recurring book', capability_id: 'acquisition_scout', weeks: 3 },
      { name: 'Bid Board Watcher', what: 'Watches ISD and municipal bid boards for fire inspection RFPs', capability_id: 'bid_watcher', weeks: 2 },
    ],
    connects: ['sales', 'inspections', 'ops'],
    systems: ['SFMO License DB', 'Permit Portals', 'ISD/Municipal Bid Boards'],
    questions: [
      { q: 'What share of your revenue is under a recurring ITM agreement today versus one-off project work?', chips: ['Most of it recurring', 'Roughly half', 'Mostly project work'] },
      { q: 'When a new building goes up in your metros, how do you find out - and does anyone chase the inspection contract before a competitor does?', chips: ['We hear through relationships', 'The GC tells us', 'We do not systematically track it'] },
      { q: 'Outside Riverton, which Texas metro is the biggest opportunity - and would you rather grow there organically or buy a small shop with a book?', chips: ['The Austin corridor', 'Houston or DFW', 'Not sure yet'] },
    ],
  },
];

export function deptByKey(key: string): DepartmentDef | undefined {
  return DEPARTMENTS.find((d) => d.key === key);
}
