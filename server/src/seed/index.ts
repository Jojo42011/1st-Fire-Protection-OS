import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import {
  createRequest,
  completeItem,
  approveItem,
  type OnboardingPayload,
} from '../services/onboardingAgent';
import { upsertNode } from '../db/memory';
import { PILLARS } from '../config/auditor';
import { DEPARTMENTS } from '../config/departments';
import { COMPANY } from '../config/constants';
import { SAMPLE_TAKEOFF, type TakeoffItem } from '../services/estimatorAgent';

/**
 * Idempotent seed - guarded by a system_state flag so every dashboard looks alive on first
 * boot (standalone-until-connected). Safe to call on every boot; only runs once.
 */
export function seed(): void {
  // The audit foundation + sample content run on their own flags so existing brains
  // (already seeded) still pick them up on upgrade.
  ensureAuditFoundation();
  seedAudit();
  seedGrowth();
  seedOffCatalog();
  seedQuestions();
  seedAgents();
  seedHarness();
  seedAssociations();
  seedCalibration();
  seedLicenses();
  seedOnboarding();
  seedApprovals();
  seedCrm();
  seedFiveAgents();
  seedEstimator();
  seedCloser();
  seedPlans();
  seedDispatch();
  seedCosting();

  if (getState('seeded') === '1') return;
  const db = getDb();

  const daysAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const isoAgo = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();

  /* ---------- invoices (16 across aging buckets, ~$3.5M outstanding) - real Texas customers + service lines ---------- */
  const invoices: [string, string, string, number, number, string][] = [
    // customer, email, phone, amount, dueOffsetDays(negative=overdue), status
    ['Riverton Heights ISD', 'ap@ahisd.example', '+1 512 555 0210', 48200.0, -8, 'sent'],            // district-wide sprinkler inspection & tag
    ['Riverwalk Hospitality Group', 'billing@rwhg.example', '+1 512 555 0231', 62500.0, -3, 'reminded'], // hood suppression - 9 properties
    ['College Station Auto Group', 'ap@cstxautogroup.example', '+1 979 555 0338', 19500.0, -2, 'sent'],  // emergency lighting & exit signage
    ['Pecan Grove HOA', 'board@pecangrovehoa.example', '+1 281 555 0305', 6400.0, -5, 'sent'],     // clubhouse & amenity extinguishers
    ['Frost Data Center (Austin)', 'ap@frostdc.example', '+1 512 555 0412', 128000.0, -12, 'sent'], // tenant fit-out pre-action sprinkler
    ['Millbrook Retail Plaza', 'billing@millbrookretail.example', '+1 254 555 0281', 54000.0, -22, 'sent'],  // quarterly inspection - sprinkler & alarm
    ['Buda Logistics Park', 'ap@budalogistics.example', '+1 512 555 0244', 87300.0, -28, 'reminded'], // fire alarm panel upgrade
    ['Museum District Tower (Houston)', 'finance@mdtower.example', '+1 713 555 0455', 210000.0, -35, 'reminded'], // high-rise standpipe & pump ITM
    ['Lakeside Distribution Center', 'ap@lakesidedist.example', '+1 956 555 0268', 36000.0, -42, 'sent'], // dry system service
    ['South Texas Medical Center', 'finance@stmc.example', '+1 512 555 0257', 397500.0, -45, 'reminded'], // fire pump replacement & test
    ['Lubbock County Facilities', 'ap@lubbockco.example', '+1 806 555 0293', 145000.0, -58, 'reminded'], // backflow & sprinkler retrofit
    ['Gulf Coast Manufacturing', 'ap@gcmfg.example', '+1 361 555 0279', 425000.0, -67, 'reminded'], // new sprinkler system install
    ['Fairview Convention Center', 'ap@fairviewcc.example', '+1 956 555 0327', 96000.0, -78, 'reminded'], // alarm system modernization
    ['Spring Industrial Warehouse', 'accounts@springwh.example', '+1 281 555 0316', 283000.0, -95, 'reminded'], // high-hazard ESFR sprinkler & hydrotest
    ['Permian Basin Energy Campus', 'ap@pbenergy.example', '+1 432 555 0501', 512000.0, -120, 'reminded'], // campus-wide fire alarm & sprinkler retrofit
    ['Port of Corpus Christi Terminal', 'finance@poccterminal.example', '+1 361 555 0523', 989600.0, -140, 'reminded'], // terminal fire protection retrofit (master contract)
  ];
  const insInv = db.prepare(
    `INSERT INTO invoices (customer, email, phone, amount, issued_at, due_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [customer, email, phone, amount, dueOff, status] of invoices) {
    insInv.run(customer, email, phone, amount, daysAgo(-dueOff + 30), daysAgo(-dueOff), status);
  }
  // a couple paid this month to make the "collected" KPI real
  const insPaid = db.prepare(
    `INSERT INTO invoices (customer, email, amount, issued_at, due_at, status, paid_at) VALUES (?, ?, ?, ?, ?, 'paid', ?)`
  );
  insPaid.run('Eastside Fitness (SA)', 'gm@eastsidefit.example', 2200.0, daysAgo(40), daysAgo(10), daysAgo(4));
  insPaid.run('Magnolia Offices (Spring)', 'ap@magnoliaoffices.example', 3100.0, daysAgo(50), daysAgo(20), daysAgo(9));

  /* ---------- jobs (completed ServiceTrade jobs → request queue) ---------- */
  const jobs: [string, string][] = [
    ['Riverton Heights ISD', 'Annual fire sprinkler inspection & tag'],
    ['Riverwalk Hospitality Group', 'Kitchen hood suppression semi-annual service'],
    ['Buda Logistics Park', 'Fire alarm panel service call'],
    ['Lakeside Self Storage', 'Dry system trip test'],
    ['Millbrook Retail Plaza', 'Quarterly inspection - sprinkler & alarm'],
    ['Pecan Grove HOA', 'Clubhouse extinguisher recharge'],
    ['Fairview Bakery Co.', 'Kitchen hood suppression check'],
    ['College Station Auto', 'Emergency lighting & exit sign test'],
  ];
  const insJob = db.prepare(
    `INSERT INTO jobs (customer, job_desc, completed_at, requested) VALUES (?, ?, ?, 0)`
  );
  jobs.forEach((j, i) => insJob.run(j[0], j[1], daysAgo(i + 2)));

  /* ---------- reviews (mostly 4-5★, a couple 3★) - Google + Facebook ---------- */
  const reviews: [string, string, number, string, number][] = [
    ['google', 'Marcus T.', 5, 'Showed up on time, explained everything, and got our sprinkler system tagged same day. White-glove all the way.', 6],
    ['google', 'Priya S.', 5, 'Drove down from Riverton to our Lakeside site without blinking. Single-source for all our life safety now.', 11],
    ['google', 'Dave R.', 4, 'Good work on our backflow test. Took a little longer than quoted but the quality was there.', 15],
    ['facebook', 'Angela M.', 5, 'Lifesavers, literally. Their inspector caught an alarm code issue our last company missed for years.', 21],
    ['google', 'Tomás L.', 3, 'Job got done but scheduling was a bit of a runaround. The tech himself was great.', 28],
    ['facebook', 'Karen W.', 5, 'Licensed, insured, HUB-certified, and they actually pick up the phone. Rare these days.', 33],
    ['google', 'Sam P.', 4, 'Solid annual inspection, clear report. Would use again for our Millbrook property.', 40],
    ['google', 'Nina H.', 3, 'Pricing was fair but I had to follow up twice for the ITM paperwork.', 47],
    ['google', 'Reggie B.', 5, '108 years of combined experience shows. Knew our old fire pump inside and out.', 55],
  ];
  const insRev = db.prepare(
    `INSERT INTO reviews (source, author, stars, text, received_at, reply_status) VALUES (?, ?, ?, ?, ?, 'none')`
  );
  for (const [source, author, stars, text, dago] of reviews) {
    insRev.run(source, author, stars, text, daysAgo(dago));
  }

  /* ---------- calls + leads (receptionist demo) - real SA routing outcomes ---------- */
  const calls: [string, number, string, string, string, number][] = [
    // from, duration, intent, outcome, transcript, minsAgo
    ['+1 512 555 0142', 184, 'Inspection request', 'transferred', 'Caller needs an annual sprinkler inspection for a warehouse near Riverton. Routed to Inspections group (Kayla Brooks / Mia Vance).', 22],
    ['+1 512 555 0199', 96, 'Sprinkler service', 'transferred', 'Leaking sprinkler head at a retail store. Routed to Fire Sprinkler Service (Ryan Blake).', 65],
    ['+1 512 555 0111', 240, 'New install / bid', 'transferred', 'Wants a bid for a new sprinkler system in a 40k sqft facility. Routed to Sales (Colton Chase).', 130],
    ['+1 512 555 0176', 74, 'Billing', 'transferred', 'Caller wants to pay an invoice. Routed to Accounting group.', 155],
    ['+1 512 555 0188', 152, 'Emergency', 'transferred', 'After-hours: alarm going off at a medical plaza. Flagged emergency → After-hours on-call queue.', 200],
    ['+1 512 555 0155', 63, 'Complaint', 'transferred', 'Upset about a missed appointment window. Empathized, did not argue - routed straight to David Reyes.', 240],
    ['+1 512 555 0133', 88, 'Spanish-speaking', 'message', 'Spanish caller needing extinguisher recharge. Helped in Spanish, took name/number/reason - Denise to route.', 300],
  ];
  const insCall = db.prepare(
    `INSERT INTO calls (from_number, started_at, duration, transcript, intent, outcome) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const [from, dur, intent, outcome, transcript, mins] of calls) {
    insCall.run(from, isoAgo(mins), dur, transcript, intent, outcome);
  }

  const leads: [string, string, string, string, string][] = [
    ['Northside Warehouse Co.', '+1 512 555 0142', '1200 Industrial Blvd, Riverton, TX', 'Annual sprinkler inspection', 'booked'],
    ['Maria Gonzalez', '+1 512 555 0199', '480 Market St, Riverton, TX', 'Leaking sprinkler head - service', 'new'],
    ['Hill Country Facility Group', '+1 512 555 0111', '900 Bandera Rd, Riverton, TX', 'New sprinkler system - bid', 'contacted'],
    ['Southtown Medical Plaza', '+1 512 555 0188', '77 Wellness Way, Riverton, TX', 'After-hours alarm - emergency', 'contacted'],
    ['José Ramírez', '+1 512 555 0133', 'Fairview, TX', 'Extinguisher recharge (Spanish)', 'new'],
  ];
  const insLead = db.prepare(
    `INSERT INTO leads (name, phone, address, need, status, source) VALUES (?, ?, ?, ?, ?, 'phone')`
  );
  for (const [name, phone, address, need, status] of leads) {
    insLead.run(name, phone, address, need, status);
  }

  /* ---------- a few seed brain rules (the real SA routing logic) ---------- */
  const insRule = db.prepare(`INSERT INTO rules (rule, scope) VALUES (?, ?)`);
  insRule.run('Never quote a price on a call - capture details and route to Sales/Ops.', 'receptionist');
  insRule.run('Marcus Hale (President) → send to voicemail every time. Do not transfer.', 'receptionist');
  insRule.run('Any complaint → do not handle it; route straight to David Reyes, empathetic, no arguing.', 'receptionist');
  insRule.run('Spanish-speaking caller → help in Spanish, do NOT transfer; capture name/number/reason for callback.', 'receptionist');
  insRule.run('Emergency / alarm now / after-hours → After-hours on-call queue immediately.', 'receptionist');
  insRule.run('Nothing sends without human approval: reminders, review replies, and requests are drafts.', 'global');

  setState('seeded', '1');
  console.log('[seed] sample data loaded (invoices, jobs, reviews, calls, leads).');
}

/**
 * Audit foundation - the structural skeleton (pillars + the 9 real locations).
 * Runs EVERY boot, idempotent via UNIQUE constraints, so upgraded deployments get it.
 */
function ensureAuditFoundation(): void {
  const db = getDb();

  // Migrate rows recorded under the original 8-pillar model onto the real
  // 9-department model. Idempotent: once remapped there is nothing left to touch.
  // NOTE: 'growth' is now a real, current pillar (Growth & Market Expansion), so it is
  // deliberately NOT remapped/deleted here anymore.
  const REMAP: [string, string][] = [
    ['dispatch', 'service'],
    ['compliance', 'projects'],
    ['people', 'ops'],
  ];
  for (const table of ['audit_systems', 'audit_people', 'audit_workflows', 'audit_findings']) {
    for (const [oldKey, newKey] of REMAP) {
      db.prepare(`UPDATE ${table} SET pillar_key = ? WHERE pillar_key = ?`).run(newKey, oldKey);
    }
  }
  // Evan Porter is Vendor Relations - was filed under sales before vendors existed.
  db.prepare(`UPDATE audit_people SET pillar_key = 'vendors' WHERE name = 'Evan Porter'`).run();
  db.prepare(`DELETE FROM audit_pillars WHERE key IN ('dispatch','compliance','people')`).run();

  const insPillar = db.prepare(
    `INSERT OR IGNORE INTO audit_pillars (key, name, tagline, sort) VALUES (?, ?, ?, ?)`
  );
  PILLARS.forEach((p, i) => insPillar.run(p.key, p.name, p.tagline, i));

  const insLoc = db.prepare(`INSERT OR IGNORE INTO audit_locations (name, role) VALUES (?, ?)`);
  COMPANY.locations.forEach((name, i) => insLoc.run(name, i === 0 ? 'HQ' : 'branch'));
}

/**
 * Audit sample content - pre-loads what we already know about Northstar (real stack, real
 * veterans, benchmark leaks) so The Operator walks into the room already understanding
 * the business. Own flag so existing deployments pick it up.
 */
function seedAudit(): void {
  if (getState('seeded_audit') === '1') return;
  const db = getDb();

  /* systems we already know they run (from the integration catalog / ops repo) */
  const systems: [string, string, string, string, string][] = [
    // name, category, truth_for, gaps, pillar
    ['ServiceTrade', 'field-service', 'Jobs, inspections, deficiencies, invoices', 'Completions don\'t trigger reviews or collections automatically', 'inspections'],
    ['Microsoft 365 / Teams', 'comms', 'Email, call transfers, office coordination', 'Call outcomes live in chat threads, not in a system', 'ops'],
    ['Vapi + Twilio (this OS)', 'voice', 'The Riverton line - AI receptionist', '', 'reception'],
    ['Spreadsheets', 'spreadsheet', 'The real coordination layer between systems', 'Manually re-keyed from ServiceTrade; nine local versions of the truth', 'finance'],
  ];
  const insSys = db.prepare(
    `INSERT INTO audit_systems (name, category, truth_for, gaps, pillar_key) VALUES (?, ?, ?, ?, ?)`
  );
  for (const s of systems) insSys.run(...s);

  /* the veterans we already know by name (from the routing brain) */
  const people: [string, string, string, string, string, string][] = [
    // name, role, location, carries, risk, pillar
    ['David Reyes', 'Operations Manager', 'Riverton', 'Every complaint and unclassifiable call routes through him - the escalation brain', 'high', 'ops'],
    ['Kayla Brooks', 'Inspections Scheduling', 'Riverton', 'Holds the inspection calendar and AHJ scheduling quirks', 'high', 'inspections'],
    ['Ryan Blake', 'Sprinkler Service Manager', 'Riverton', 'Sprinkler service triage and crew knowledge', 'medium', 'service'],
    ['Mitch Shafer', 'Fire Alarm Service Manager', 'Riverton', 'Alarm service triage; panel/system history by account', 'medium', 'service'],
    ['Evan Porter', 'Vendor Relations', 'Riverton', 'Supplier relationships and pricing history', 'medium', 'vendors'],
  ];
  const insPpl = db.prepare(
    `INSERT INTO audit_people (name, role, location, carries, risk, pillar_key) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const p of people) insPpl.run(...p);

  /* the heartbeat workflow, traced */
  db.prepare(
    `INSERT INTO audit_workflows (name, trigger_desc, stalls, pillar_key) VALUES (?, ?, ?, ?)`
  ).run(
    'Inspection → deficiency → repair → cash (the ITM lifecycle)',
    'NFPA cadence: contract schedules the inspection',
    'Deficiency-to-quote lag; quote follow-up; invoice-to-payment aging',
    'inspections'
  );

  /* benchmark findings pre-loaded so the leak table opens alive */
  const findings: [string, string, string, string, string, string, string][] = [
    // pillar, kind, title, detail, severity, cost_hint, capability
    ['inspections', 'leak', 'Deficiency findings are managed informally, not as a pipeline',
      'Systematic shops convert 30 to 50% of deficiencies into paid repairs; informal handling leaves that revenue on the table.',
      'high', '30 to 50% of repair revenue', 'deficiency_pipeline'],
    ['sales', 'leak', 'Repair quotes take days to go out after an inspection',
      'Quotes sent within 24h convert 2 to 3× better than week-old quotes. Turnaround is the #1 conversion lever.',
      'high', '2 to 3× conversion delta', 'quote_drafter'],
    ['finance', 'leak', 'Receivables chased by hand, invoices go out late',
      '~60% of contractor invoices are paid late; manual invoicing adds 15 to 30 days of DSO.',
      'high', '15 to 30 days of DSO', 'invoice_chaser'],
    ['ops', 'gap', 'Nine locations, no side-by-side view of the same numbers',
      'Each branch runs its own way; variance is invisible until it becomes a problem. One brain over all nine is the consolidation play.',
      'medium', '', 'location_command'],
  ];
  const insFnd = db.prepare(
    `INSERT INTO audit_findings (pillar_key, kind, title, detail, severity, cost_hint, capability_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const f of findings) insFnd.run(...f);

  // Riverton is where the audit starts - HQ is touched by definition.
  db.prepare(`UPDATE audit_locations SET mapped = 1 WHERE role = 'HQ'`).run();

  setState('seeded_audit', '1');
  console.log('[seed] audit foundation loaded (pillars, locations, known systems, veterans, benchmark leaks).');
}

/**
 * Growth intelligence - context fed in from Booker Growth's Texas fire-protection market
 * research so The Operator walks in already seeing the GROWTH gaps, not just operational
 * leaks. Illustrative/benchmark findings (no invented accounts); the real targets come
 * from the public feeds (SFMO license DB, permits, bid boards) when connected. Own flag so
 * existing brains pick it up on upgrade.
 */
function seedGrowth(): void {
  if (getState('seeded_growth') === '1') return;
  const db = getDb();

  // the public feeds that power expansion - a "system of record" the OS should mine
  db.prepare(
    `INSERT INTO audit_systems (name, category, truth_for, gaps, pillar_key) VALUES (?, ?, ?, ?, ?)`
  ).run(
    'SFMO License DB + Permit Portals + Bid Boards',
    'public-data',
    'Texas competitor map, new-construction signal, and competitively-bid contracts',
    'All public and free, none of it mined today - competitor/white-space map, acquisition targets, permit-to-ITM signal, and ISD/municipal RFPs are unused',
    'growth'
  );

  const findings: [string, string, string, string, string, string, string][] = [
    // pillar, kind, title, detail, severity, cost_hint, capability
    ['growth', 'gap', 'New-construction permits that become ITM accounts are not captured systematically',
      'Every new commercial building is a code-mandated future inspection account. Catching the permit and timing outreach to the acceptance test converts installs into decades of recurring ITM; today it is relationship-driven, not systematic.',
      'high', 'future recurring ITM', 'permit_hunter'],
    ['growth', 'leak', 'Installs and one-off repairs are not converted into recurring agreements',
      'Recurring ITM mix is the master value driver - operators at 40%+ recurring trade 2 to 3 EBITDA turns higher. Every completed install/one-off without an agreement is recurring revenue left on the table.',
      'high', '2 to 3 EBITDA turns', 'recurring_capture'],
    ['growth', 'gap', 'Competitor and white-space map lives in people\'s heads, not on a board',
      'The Texas SFMO publishes every licensed fire contractor. Mapped by metro it shows where coverage is thin (expansion white space) and which small shops are acquisition targets - density-first from Riverton outward.',
      'medium', '', 'territory_map'],
    ['growth', 'gap', 'Small independent shops are being consolidated by nationals, not sourced here first',
      'The market is fragmented and consolidating fast; a small shop with an inspection book is a portable recurring-revenue asset. The SFMO DB surfaces tuck-in targets in your own metros before a national buys the route.',
      'medium', 'route density', 'acquisition_scout'],
    ['growth', 'gap', 'ISD and municipal fire-inspection RFPs are not systematically watched',
      'School districts and cities must competitively bid inspection work; a missed posting is a missed multi-year contract. District bid boards and the state ESBD are public and watchable.',
      'medium', 'multi-year contracts', 'bid_watcher'],
  ];
  const insFnd = db.prepare(
    `INSERT INTO audit_findings (pillar_key, kind, title, detail, severity, cost_hint, capability_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const f of findings) insFnd.run(...f);

  setState('seeded_growth', '1');
  console.log('[seed] growth intelligence loaded (SFMO/permit/bid feeds + 5 growth gaps on the Growth pillar).');
}

/**
 * The interview ladder - seed each department's opening question deck (depth 0) so the
 * Operator has somewhere to start. Every answer then persists a sharper follow-up one
 * level deeper (auditAgent.capture), so the interview resumes and gets sharper across
 * sessions instead of resetting each visit. Own flag so existing brains pick it up.
 */
function seedQuestions(): void {
  if (getState('seeded_questions') === '1') return;
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO audit_questions (question, pillar_key, depth_level, status) VALUES (?, ?, 0, 'open')`
  );
  for (const d of DEPARTMENTS) {
    for (const q of d.questions) {
      const dup = db.prepare(`SELECT id FROM audit_questions WHERE lower(question) = lower(?)`).get(q.q);
      if (!dup) ins.run(q.q, d.key);
    }
  }
  setState('seeded_questions', '1');
  console.log('[seed] interview ladder seeded (opening question decks per department).');
}

/**
 * An OFF-CATALOG gap: nothing in the build catalog covers fleet maintenance, but a
 * 9-location field-service company lives and dies by its trucks. The Operator proposes a
 * CUSTOM agent for it, so the harness can grow the team beyond the preset builds. Own flag
 * so brains already seeded before this existed still pick it up on upgrade.
 */
function seedOffCatalog(): void {
  if (getState('seeded_offcatalog') === '1') return;
  const db = getDb();
  const dup = db
    .prepare(`SELECT id FROM audit_findings WHERE lower(title) LIKE 'fleet vehicle maintenance%'`)
    .get();
  if (!dup) {
    db.prepare(
      `INSERT INTO audit_findings (pillar_key, kind, title, detail, severity, cost_hint, capability_id) VALUES (?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      'ops',
      'gap',
      'Fleet vehicle maintenance is reactive, trucks fail in the field',
      'Nine locations run on service trucks, but preventive maintenance is ad hoc: a truck down mid-route means missed inspections and emergency-rate rentals. No catalog build covers this, so it needs a custom agent that tracks each vehicle, schedules PM by mileage/hours, and flags a truck before it strands a crew.',
      'medium',
      'missed routes + rental cost'
    );
    console.log('[seed] off-catalog gap seeded (fleet maintenance -> a custom agent the catalog does not cover).');
  }
  setState('seeded_offcatalog', '1');
}

/**
 * The founding roster - seed the agents this OS shipped with as rows in `agents` so the
 * roster is one unified team and the harness-built agents sit right alongside them. Each
 * gets a starter knowledge line; the harness grows the list as it strengthens them. Own
 * flag so existing brains pick it up on upgrade.
 */
function seedAgents(): void {
  if (getState('seeded_agents') === '1') return;
  const db = getDb();
  const founding: {
    key: string;
    name: string;
    role: string;
    pillar: string;
    capability_id: string;
    knowledge: string[];
  }[] = [
    {
      key: 'calls',
      name: 'Call Receptionist',
      role: 'Answers every line 24/7, classifies and routes the call, captures the lead',
      pillar: 'reception',
      capability_id: 'ai_receptionist',
      knowledge: ['Answer in the Northstar voice and never miss an after-hours emergency', 'Route inspections, service, and sales to the right desk'],
    },
    {
      key: 'invoices',
      name: 'Invoice Collector',
      role: 'Chases receivables, drafts reminders, tracks aging to paid',
      pillar: 'finance',
      capability_id: 'invoice_chaser',
      knowledge: ['Escalate a reminder cadence until an invoice is paid', 'Know the aging buckets and flag the oldest first'],
    },
    {
      key: 'reviews',
      name: 'Review Collector',
      role: 'Requests reviews on job completion, drafts replies, tracks reputation',
      pillar: 'reception',
      capability_id: 'review_engine',
      knowledge: ['Ask for a review the moment a job closes', 'Draft an on-brand reply to every review, good or bad'],
    },
    {
      key: 'audit',
      name: 'The Operator',
      role: 'Maps the whole company live, finds the leaks, proposes the AI builds',
      pillar: 'ops',
      capability_id: 'operator_brain',
      knowledge: ['Interview the owner one question at a time and go deeper every session', 'Turn every leak found into a proposed build for the harness'],
    },
  ];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO agents (key, name, role, pillar_key, capability_id, knowledge, origin, status)
     VALUES (?, ?, ?, ?, ?, ?, 'founding', 'live')`
  );
  const skillIns = db.prepare(`INSERT INTO agent_skills (agent_key, skill) VALUES (?, ?)`);
  for (const a of founding) {
    const r = ins.run(a.key, a.name, a.role, a.pillar, a.capability_id, JSON.stringify(a.knowledge));
    if (r.changes) for (const s of a.knowledge) skillIns.run(a.key, s);
  }
  setState('seeded_agents', '1');
  console.log('[seed] founding roster seeded (4 agents live; the harness grows the team from here).');
}

/**
 * Open the Harness alive: pre-approve one already-seeded growth gap (queue_status =
 * 'approved') so the harness inbox shows a real work order to run on first visit, without
 * touching the Operator's own proposed feed. Its own flag; idempotent; only acts if it can
 * find a growth gap with a capability and nothing is approved yet.
 */
function seedHarness(): void {
  if (getState('seeded_harness') === '1') return;
  const db = getDb();
  const any = db.prepare(`SELECT id FROM audit_findings WHERE queue_status = 'approved' LIMIT 1`).get();
  if (!any) {
    const pick = db
      .prepare(
        `SELECT id FROM audit_findings
         WHERE pillar_key = 'growth' AND capability_id IS NOT NULL AND capability_id <> ''
         ORDER BY id ASC LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (pick) {
      db.prepare(
        `UPDATE audit_findings SET queue_status = 'approved', value_line = 'recurring ITM revenue' WHERE id = ?`
      ).run(pick.id);
      console.log('[seed] harness seeded (one approved growth gap staged in the inbox).');
    }
  }
  setState('seeded_harness', '1');
}

/* ─────────────────────── the self-knowing brain (seed) ───────────────────────
 * Seed calibration + association data so the "How well it knows" view and the
 * Associations panel render something on first boot. Every row carries sample=1 as internal
 * plumbing (not rendered in the UI). No
 * Math.random: deterministic values, reusing the repo's FNV-1a -> mulberry32 pattern where a
 * number varies; relative timestamps follow the existing seed helpers so decay stays alive. */

/** FNV-1a hash of a key -> unsigned 32-bit seed (same pattern as routes/department.ts). */
function seedFrom(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** mulberry32: a tiny deterministic PRNG. Same key, same sequence, always. No Math.random. */
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
/** ISO timestamp N days ago (positive = past, negative = future). Mirrors the seed helpers. */
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

/**
 * Associative memory seed: real Northstar entities that genuinely go together (the deficiency
 * pipeline lives in ServiceTrade, Kelsey holds inspections, spreadsheets drive receivables),
 * wired as decaying associations. A couple are older so the panel visibly shows decay. The two
 * finding nodes here match seeded findings by title so the combined loop has real nodes to
 * reinforce when their predictions resolve. Own flag; idempotent.
 */
function seedAssociations(): void {
  if (getState('seeded_assoc') === '1') return;
  const db = getDb();

  const seedAssoc = (
    aLabel: string,
    aKind: string,
    bLabel: string,
    bKind: string,
    weight: number,
    daysAgo: number
  ) => {
    const a = upsertNode(aLabel, aKind);
    const b = upsertNode(bLabel, bKind);
    const src = Math.min(a, b);
    const dst = Math.max(a, b);
    const dup = db.prepare(`SELECT id FROM edges WHERE src = ? AND dst = ? AND relation = 'assoc'`).get(src, dst);
    if (!dup) {
      db.prepare(
        `INSERT INTO edges (src, dst, relation, weight, last_reinforced_at, sample) VALUES (?, ?, 'assoc', ?, ?, 1)`
      ).run(src, dst, weight, isoDaysAgo(daysAgo));
    }
  };

  const DEF = 'Deficiency findings are managed informally, not as a pipeline';
  const QUOTES = 'Repair quotes take days to go out after an inspection';
  const RECV = 'Receivables chased by hand, invoices go out late';
  const NINE = 'Nine locations, no side-by-side view of the same numbers';

  // [aLabel, aKind, bLabel, bKind, weight, daysAgoReinforced]
  const links: [string, string, string, string, number, number][] = [
    ['ServiceTrade', 'system', DEF, 'finding', 0.82, 3],
    ['ServiceTrade', 'system', QUOTES, 'finding', 0.7, 6],
    [DEF, 'finding', QUOTES, 'finding', 0.64, 5],
    ['Kayla Brooks', 'person', DEF, 'finding', 0.58, 9],
    ['Spreadsheets', 'system', RECV, 'finding', 0.75, 4],
    ['ServiceTrade', 'system', 'Spreadsheets', 'system', 0.5, 20],
    ['Spreadsheets', 'system', NINE, 'finding', 0.55, 12],
    ['David Reyes', 'person', QUOTES, 'finding', 0.3, 42], // old + weak: shows decay in the panel
  ];
  for (const [al, ak, bl, bk, w, d] of links) seedAssoc(al, ak, bl, bk, w, d);

  setState('seeded_assoc', '1');
  console.log('[seed] associations seeded (decaying association graph, illustrative edges).');
}

/**
 * Calibration ledger seed: Operator predictions, mostly resolved so the
 * reliability curve renders on first load, plus two open ones (tied to real seeded findings)
 * the user can resolve live to see the combined loop fire. Fire-protection claims,
 * every row carries sample=1. Own flag; idempotent.
 */
function seedCalibration(): void {
  if (getState('seeded_calibration') === '1') return;
  const db = getDb();
  const r = rngFrom('calibration:northstardemo'); // deterministic jitter for created/horizon offsets

  const findingIdByTitle = (title: string): string | null => {
    const row = db.prepare(`SELECT id FROM audit_findings WHERE title = ? ORDER BY id ASC LIMIT 1`).get(title) as
      | { id: number }
      | undefined;
    return row ? String(row.id) : null;
  };

  const ins = db.prepare(
    `INSERT INTO predictions
       (claim_kind, ref_id, statement, predicted_confidence, predicted_outcome, horizon_at, status, actual_outcome, resolved_by, resolved_at, sample, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  );

  // Resolved predictions: [kind, statement, conf, outcome, status, actual, resolvedBy, createdDaysAgo, horizonDaysAgo]
  const resolved: [string, string, number, string, string, string, string, number, number][] = [
    ['value', 'Recurring ITM capture on the new-construction permit cohort adds durable inspection revenue', 0.8,
      'future recurring ITM', 'confirmed', '3 permit accounts converted to annual ITM agreements', 'Devon', 66, 34],
    ['value', '24-hour quote turnaround lifts deficiency-to-repair conversion', 0.85,
      '2-3x conversion delta', 'confirmed', 'repair close rate rose on same-week quotes', 'Devon', 58, 27],
    ['gap', 'Consolidating nine branches onto one dashboard surfaces branch variance', 0.7,
      'variance visible across sites', 'confirmed', 'two outlier branches identified in week one', 'Devon', 50, 20],
    ['value', 'Daily receivables dunning cuts DSO on the aging bucket', 0.75,
      '15-30 days of DSO', 'confirmed', 'DSO down on the enrolled invoices', 'Devon', 47, 16],
    ['forecast', 'Backflow retrofit renewals close before quarter end', 0.65,
      'renewals signed', 'partial', 'about half signed on time, rest slipped a cycle', 'Devon', 44, 13],
    ['gap', 'The SFMO license map reveals tuck-in acquisition targets in South Texas', 0.6,
      'route-dense targets found', 'partial', 'targets surfaced, none actionable this quarter', 'Devon', 40, 11],
    ['forecast', 'The ISD bid-board watcher lands a multi-year district contract this cycle', 0.8,
      'multi-year contract', 'refuted', 'no award this cycle; the timeline was overconfident', 'Devon', 70, 30],
    ['value', 'One-off repair jobs convert to recurring agreements without a nudge', 0.7,
      'recurring conversion', 'refuted', 'conversions needed the agreement offer, not automatic', 'Devon', 55, 25],
  ];
  for (const [kind, statement, conf, outcome, status, actual, by, cd, hd] of resolved) {
    // horizon and resolution land around hd days ago, nudged deterministically (no Math.random)
    const jitter = Math.round(r() * 3); // 0..3 days, stable per boot sequence
    ins.run(kind, null, statement, conf, outcome, isoDaysAgo(hd + jitter), status, actual, by, isoDaysAgo(hd), isoDaysAgo(cd));
  }

  // Open predictions tied to REAL seeded findings, so resolving one live fires the combined
  // loop against real association nodes (never invented).
  const open: [string, string, number, string, number, number][] = [
    // [kind, findingTitle, conf, outcome, createdDaysAgo, horizonDaysAhead]
    ['value', 'Deficiency findings are managed informally, not as a pipeline', 0.8, '30-50% of repair revenue', 8, 22],
    ['gap', 'Nine locations, no side-by-side view of the same numbers', 0.7, 'consolidated branch visibility', 6, 24],
  ];
  for (const [kind, title, conf, outcome, cd, ha] of open) {
    ins.run(kind, findingIdByTitle(title), title, conf, outcome, isoDaysAgo(-ha), 'open', null, null, null, isoDaysAgo(cd));
  }

  setState('seeded_calibration', '1');
  console.log('[seed] calibration ledger seeded (illustrative predictions: 8 resolved, 2 open).');
}

/* ─────────────────────── License Reclaim (seed) ───────────────────────
 * The HR roster (BambooHR, seeded fallback when keyless) plus the software-license seat
 * inventory across all six vendors (Adobe, Bluebeam, AutoCAD, HydraCAD, HFSS, Microsoft 365).
 * Several employees are terminated but still hold seats, so the reclaimable list and a real
 * annual savings number render on first boot. Deterministic (the FNV-1a -> mulberry32 PRNG for
 * date jitter, no Math.random). Own flag; idempotent (email + name unique guards). */
function seedLicenses(): void {
  if (getState('seeded_licenses') === '1') return;
  const db = getDb();
  const r = rngFrom('licenses:northstardemo'); // deterministic jitter for hire/assign dates
  const dateAgo = (n: number) => isoDaysAgo(n).slice(0, 10); // YYYY-MM-DD
  const jit = (span: number) => Math.round(r() * span); // 0..span days, stable per boot

  const COST: Record<string, number> = { adobe: 60, microsoft: 36, autocad: 200, bluebeam: 22, hydracad: 25, hfss: 20 };
  const PRODUCT: Record<string, string> = {
    adobe: 'Creative Cloud All Apps',
    microsoft: 'Microsoft 365 E3',
    autocad: 'AutoCAD (Autodesk)',
    bluebeam: 'Bluebeam Revu',
    hydracad: 'HydraCAD (Hydratec)',
    hfss: 'HFSS',
  };
  const emailFor = (name: string) => name.trim().toLowerCase().split(/\s+/).join('.') + '@northstardemo.example';

  // roster: [full_name, department, title, terminatedDaysAgo] (0 = active)
  const roster: [string, string, string, number][] = [
    ['Marcus Hale', 'Executive', 'President', 0],
    ['Irene Hale', 'Executive', 'Co-Founder', 0],
    ['Curtis Holloway', 'Operations', 'Chief Operating Officer', 0],
    ['David Reyes', 'Operations', 'Operations Manager', 0],
    ['Kayla Brooks', 'Inspections', 'Inspections Scheduler', 0],
    ['Mia Vance', 'Inspections', 'Inspections Coordinator', 0],
    ['Brett Vaughn', 'Inspections', 'Lead Inspector', 0],
    ['Ryan Blake', 'Service', 'Sprinkler Service Manager', 0],
    ['Mitch Shafer', 'Service', 'Fire Alarm Service Manager', 0],
    ['Shane Tolliver', 'Service', 'Extinguisher Technician', 0],
    ['Tara Reese', 'Service', 'Extinguisher Technician', 0],
    ['Colton Chase', 'Sales', 'Sprinkler Sales', 0],
    ['Mark Maddox', 'Sales', 'Fire Alarm Sales', 0],
    ['Nate Fowler', 'Sales', 'Estimator', 0],
    ['Prisha Nadar', 'Projects', 'Project Manager', 0],
    ['Vince Delano', 'Projects', 'Sprinkler Designer', 0],
    ['Sonia Marlow', 'Projects', 'Sprinkler Designer', 0],
    ['Roman Choi', 'Projects', 'Estimator', 0],
    ['Gwen Barrett', 'Finance', 'Controller', 0],
    ['Hugo Ballard', 'Finance', 'AR Specialist', 0],
    ['Amina Kader', 'Finance', 'AP Specialist', 0],
    ['Dana Alvi', 'Reception', 'Front Desk Coordinator', 0],
    ['Carmen Juarez', 'Admin', 'HR Coordinator', 0],
    ['Evan Porter', 'Vendors', 'Vendor Relations', 0],
    // terminated, still holding seats -> reclaimable
    ['Jared Pope', 'Projects', 'Sprinkler Designer', 69],
    ['Miles Ward', 'Projects', 'Estimator', 108],
    ['Dean Marsh', 'Projects', 'CAD Designer', 160],
    ['Elaine Vargas', 'Sales', 'Sales Representative', 49],
    ['Renee Stark', 'Admin', 'Marketing Coordinator', 53],
    ['Trey Hoang', 'Service', 'Fire Alarm Technician', 124],
    ['Owen Hadley', 'Finance', 'Staff Accountant', 35],
    ['Layla Keene', 'Inspections', 'Inspector', 179],
  ];

  const insEmp = db.prepare(
    `INSERT OR IGNORE INTO hr_employees (full_name, email, department, title, status, hired_at, terminated_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'seed')`
  );
  for (const [name, dept, title, termDaysAgo] of roster) {
    const status = termDaysAgo > 0 ? 'terminated' : 'active';
    const hired = dateAgo(365 * (1 + (jit(6))) + jit(280) + (termDaysAgo || 0)); // hired before any termination
    const terminated = termDaysAgo > 0 ? dateAgo(termDaysAgo) : null;
    insEmp.run(name, emailFor(name), dept, title, status, hired, terminated);
  }

  // seats: everyone (active + terminated) holds a Microsoft 365 seat; the pro/design tools go
  // to the people who use them. Terminated employees keep every seat until a human reclaims it.
  const insSeat = db.prepare(
    `INSERT INTO license_seats (vendor, product, assignee_email, assignee_name, cost_monthly, assigned_at, source)
     VALUES (?, ?, ?, ?, ?, ?, 'seed')`
  );
  const addSeat = (vendor: string, name: string, email: string) => {
    insSeat.run(vendor, PRODUCT[vendor], email, name, COST[vendor], dateAgo(120 + jit(600)));
  };

  // guard against a re-run inserting duplicate seats (own flag already guards, this is belt-and-suspenders)
  const already = db.prepare(`SELECT COUNT(*) AS c FROM license_seats`).get() as { c: number };
  if (already.c === 0) {
    for (const [name] of roster) addSeat('microsoft', name, emailFor(name));

    // extra vendor seats per person (beyond the base Microsoft 365 seat)
    const extra: [string, string[]][] = [
      ['Vince Delano', ['autocad', 'hydracad', 'bluebeam', 'hfss']],
      ['Sonia Marlow', ['autocad', 'hydracad', 'bluebeam']],
      ['Roman Choi', ['autocad', 'bluebeam']],
      ['Prisha Nadar', ['bluebeam']],
      ['Nate Fowler', ['bluebeam']],
      ['Colton Chase', ['bluebeam']],
      ['Carmen Juarez', ['adobe']],
      // terminated employees' extra seats (these become reclaimable)
      ['Jared Pope', ['autocad', 'hydracad', 'bluebeam', 'adobe', 'hfss']],
      ['Miles Ward', ['autocad', 'bluebeam']],
      ['Dean Marsh', ['autocad', 'bluebeam', 'hydracad']],
      ['Elaine Vargas', ['adobe']],
      ['Renee Stark', ['adobe']],
      ['Layla Keene', ['bluebeam']],
    ];
    for (const [name, vendors] of extra) for (const v of vendors) addSeat(v, name, emailFor(name));

    // a seat assigned to someone NOT on the roster at all (a departed contractor whose seats
    // were never cleaned up) -> reclaimable via the "off-roster" branch.
    addSeat('autocad', 'Gene Sandberg', 'gene.sandberg@northstardemo.example');
    addSeat('microsoft', 'Gene Sandberg', 'gene.sandberg@northstardemo.example');
  }

  setState('seeded_licenses', '1');
  console.log('[seed] license reclaim seeded (roster + 6-vendor seat inventory; several terminated seats reclaimable).');
}

/* ─────────────────────── New-hire Onboarding (seed) ───────────────────────
 * Three onboarding requests at different stages so the board and the grouped-items view
 * render on first boot: one fresh (everything pending), one partway (about half settled),
 * one complete (every item done/approved). Each is routed through the real onboardingAgent
 * so the seeded items match the live routing map exactly. Advancement is deterministic (a
 * fixed cadence over the item list, no Math.random). Own flag; idempotent. */
function seedOnboarding(): void {
  if (getState('seeded_onboarding') === '1') return;
  const db = getDb();

  // guard: if any request already exists, do not double-seed
  const already = db.prepare(`SELECT COUNT(*) AS c FROM onboarding_requests`).get() as { c: number };
  if (already.c > 0) {
    setState('seeded_onboarding', '1');
    return;
  }

  const isoDay = (n: number) => isoDaysAgo(n).slice(0, 10);

  // A CAD designer: CAD laptop + Bluebeam/AutoCAD/HydraCAD (Mario approvals), design SharePoint,
  // full IT provisioning. Left fully pending so the board opens with real approvals to work.
  const fresh: OnboardingPayload = {
    name: 'Sofia Ramos',
    personal_email: 'sofia.ramos@gmail.example',
    start_date: isoDay(-10),
    cell_phone: '+1 512 555 0611',
    job_position: 'CAD Designer',
    salary: '$78,000 / yr',
    manager_name: 'Prisha Nadar',
    company_email: true,
    teams_number: true,
    computer_type: 'cad',
    software: ['Microsoft 365 desktop apps', 'Adobe Acrobat', 'HFSS', 'Bluebeam', 'AutoCAD', 'HydraCAD'],
    sharepoint: ['Riverton (FPS)', 'FIRCON', 'MGMT'],
    printers: ['Riverton Regular', 'Riverton Plotter'],
    company_cell: true,
    ipad: true,
    probation_waived: true,
  };

  // A Riverton field hire: company vehicle (fans to Sandi/Denise/Daniel) + WEX + iPad, a
  // couple of pay exceptions. Partway: about half the items settled.
  const partway: OnboardingPayload = {
    name: 'Marcus Bell',
    personal_email: 'marcus.bell@gmail.example',
    start_date: isoDay(-3),
    cell_phone: '+1 512 555 0642',
    job_position: 'Fire Alarm Technician',
    salary: '$64,000 / yr',
    manager_name: 'Mitch Shafer',
    company_email: true,
    teams_number: true,
    computer_type: 'standard',
    software: ['Microsoft 365 desktop apps'],
    sharepoint: ['Riverton (FPS)', 'SAFETY'],
    printers: ['Riverton Regular'],
    company_cell: true,
    ipad: true,
    company_vehicle: true,
    vehicle_details: 'Ford Transit 250 - unit SA-14 (transfer from the retiring tech)',
    wex_card: true,
    cell_reimburse: true,
    hours_80_40: true,
  };

  // An office hire, fully onboarded: everything done/approved so a complete card renders.
  const done: OnboardingPayload = {
    name: 'Grace Okoro',
    personal_email: 'grace.okoro@gmail.example',
    start_date: isoDay(21),
    cell_phone: '+1 512 555 0658',
    job_position: 'AP Specialist',
    salary: '$56,000 / yr',
    manager_name: 'Gwen Barrett',
    company_email: true,
    teams_number: true,
    computer_type: 'business',
    software: ['Microsoft 365 desktop apps', 'Adobe Acrobat'],
    sharepoint: ['Riverton (FPS)', 'ACCT', 'Payroll'],
    printers: ['Riverton Accounting'],
    incentive_plan: true,
  };

  const settleAll = (id: number) => {
    const items = db.prepare(`SELECT id, kind FROM onboarding_items WHERE request_id = ?`).all(id) as {
      id: number;
      kind: string;
    }[];
    for (const it of items) {
      if (it.kind === 'approval') approveItem(it.id, 'Devon');
      else completeItem(it.id, 'operator');
    }
  };
  // deterministic partial settle: settle every other item (by position), no Math.random
  const settleHalf = (id: number) => {
    const items = db.prepare(`SELECT id, kind FROM onboarding_items WHERE request_id = ? ORDER BY id ASC`).all(id) as {
      id: number;
      kind: string;
    }[];
    items.forEach((it, i) => {
      if (i % 2 !== 0) return; // leave the odd-indexed items pending
      if (it.kind === 'approval') approveItem(it.id, 'Devon');
      else completeItem(it.id, 'operator');
    });
  };

  createRequest(fresh); // stays fully pending
  const p = createRequest(partway);
  settleHalf(p.request.id);
  const c = createRequest(done);
  settleAll(c.request.id);

  setState('seeded_onboarding', '1');
  console.log('[seed] onboarding seeded (3 requests: one fresh, one partway, one complete; routed through the live map).');
}

/**
 * Approvals inbox fixtures (Signal Phase 3). Five pending items, two flagged routine
 * (the SMS reminder and the review reply/request) - those are what "Approve all routine"
 * clears. Copy is lifted verbatim from the design so Home + the inbox match it side by
 * side. Own flag so existing brains pick it up on upgrade. */
function seedApprovals(): void {
  if (getState('seeded_approvals') === '1') return;
  const db = getDb();

  // agent_key, kind, risk, title, stake, body, trail, subject_type
  const rows: [string, string, string, string, string, string, string, string][] = [
    [
      'invoices', 'send_email', 'sensitive',
      'Final notice to Maplewood Medical Plaza', '$34,800',
      '"Hi Marcy - invoice #4471 for the Q1 sprinkler inspection is now 98 days past due at $34,800. We’ve sent three reminders. Please confirm today whether this is in your AP queue, or we’ll need to pause scheduled service at the plaza."',
      'Goes to marcy.d@maplewood.example + AP inbox', 'invoice',
    ],
    [
      'reviews', 'publish', 'routine',
      'Reply to Marcy Delgado ★★★★★', 'Google',
      '"Thank you, Marcy. Keeping the clinic open during an inspection is the whole job - glad the crew got it done clean. We’ll see you at the next annual."',
      'Posts on your Google Business Profile', 'review',
    ],
    [
      'licenses', 'cancel_seat', 'sensitive',
      'Cancel the Bluebeam seat for T. Nguyen', 'saves $1,752/yr',
      'Terminated 2026-04-30 per BambooHR, but the seat is still active and billing $146/mo. Offboarding task drafted for IT: revoke the license and move shared markups to the estimating pool.',
      'IT gets the task; nothing cancels until they run it', 'seat',
    ],
    [
      'invoices', 'send_sms', 'routine',
      'Friendly reminder to Stone Oak Retail Partners', '$18,400',
      '"Hi - just a heads up that invoice #4518 for the extinguisher recharge is 34 days out. Happy to resend the paperwork or take a card over the phone. - Northstar Fire & Safety"',
      'SMS to the billing contact on file', 'invoice',
    ],
    [
      'reviews', 'send_email', 'routine',
      'Review request to Live Oak Distribution Center', '6 queued',
      '"Thanks for having us out Tuesday - if the crew took care of you, a quick Google review helps a family business more than you’d think. Here’s the link."',
      'Email; SMS follows in 3 days if unopened', 'review',
    ],
  ];

  // Space the created_at so the ages read 2m / 18m / 1h / 3h / 5h ago like the design.
  const minsAgo = [2, 18, 60, 180, 300];
  const ins = db.prepare(
    `INSERT INTO approvals (agent_key, kind, risk, title, stake, body, trail, subject_type, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  );
  rows.forEach((r, i) => {
    const at = new Date(Date.now() - minsAgo[i] * 60000).toISOString();
    ins.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], at);
  });

  setState('seeded_approvals', '1');
  console.log('[seed] approvals inbox seeded (5 pending, 2 routine).');
}

/**
 * CRM + ServiceTrade sync fixtures (Signal Phase 4, shell only). Mirrors the design's
 * sample data so Accounts / Account detail / Pipeline / Sync all look alive and match the
 * mockups side by side. ServiceTrade is NOT called; sync_objects records the intended
 * directions and everything reports live:false. Own flag so existing brains pick it up. */
function seedCrm(): void {
  if (getState('seeded_crm') === '1') return;
  const db = getDb();
  const dOff = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const iso = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();

  // ---- accounts (8 shown + 3 pipeline-only) ----
  // name, segment, contract_type, renews(+days), owner, since, balance$, lifetime$, avgDays, risk, touchKind, touchMins
  const accounts: [string, string, string, number | null, string, string, number, number, number | null, string | null, string, number][] = [
    ['Maplewood Medical Plaza', 'Medical', 'contract', 67, 'Sylvia Ruiz', '2014', 34800, 486200, 71, 'at_risk', 'call', 120],
    ['Northside ISD', 'Education', 'contract', 210, 'Sylvia Ruiz', '2009', 26950, 512000, 44, null, 'autopilot', 30],
    ['Stone Oak Retail Partners', 'Retail', 'tm', null, 'Miles Ward', '2019', 18400, 141000, 52, 'at_risk', 'quote', 7200],
    ['Live Oak Distribution Center', 'Industrial', 'contract', 120, 'Miles Ward', '2021', 9120, 98600, 39, null, 'job', 4320],
    ['Culebra Medical Group', 'Medical', 'contract', 300, 'Sylvia Ruiz', '2017', 14600, 220400, 58, null, 'review', 8640],
    ['Bulverde Self Storage', 'Storage', 'tm', null, 'Miles Ward', '2022', 0, 41200, 33, null, 'booked', 5760],
    ['Boerne Industrial Park LLC', 'Industrial', 'contract', 420, 'Sylvia Ruiz', '2012', 12300, 388000, 47, null, 'invoice', 15840],
    ['Northgate Federal Campus annex', 'Government', 'prospect', null, 'Miles Ward', 'new', 0, 0, null, null, 'call', 200],
    ['Mi Tierra (Market Sq)', 'Hospitality', 'prospect', null, 'Miles Ward', 'new', 0, 0, null, null, 'call', 600],
    ['Helotes Plaza', 'Retail', 'prospect', null, 'Miles Ward', 'new', 0, 0, null, null, 'quote', 20000],
    ['Converse Fleet Services', 'Industrial', 'contract', 360, 'Sylvia Ruiz', '2016', 0, 132000, 41, null, 'job', 10000],
  ];
  const insAcc = db.prepare(
    `INSERT INTO accounts (st_id, name, segment, contract_type, contract_renews_at, owner_user, customer_since,
       balance_cents, lifetime_cents, avg_days_to_pay, risk, last_touch_at, last_touch_kind, st_updated_at, local_updated_at, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clean')`
  );
  const accId: Record<string, number> = {};
  accounts.forEach((a, i) => {
    const renews = a[3] == null ? null : dOff(a[3]);
    const info = insAcc.run(
      'ST-' + (41822 + i), a[0], a[1], a[2], renews, a[4], a[5],
      a[6] * 100, a[7] * 100, a[8], a[9], iso(a[11]), a[10], iso(180), iso(a[11])
    );
    accId[a[0]] = Number(info.lastInsertRowid);
  });

  // ---- Maplewood full detail: sites, equipment, contacts, timeline ----
  const ar = accId['Maplewood Medical Plaza'];
  const insSite = db.prepare(
    `INSERT INTO sites (st_id, account_id, name, address, system_type, next_service_at, last_result, st_updated_at, local_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const s1 = insSite.run('ST-S1', ar, 'Main plaza', '7830 Ridge Oak', 'wet', dOff(19), 'deficiencies', iso(180), iso(180));
  const s2 = insSite.run('ST-S2', ar, 'Imaging annex', '7834 Ridge Oak', 'pre-action', dOff(300), 'passed', iso(180), iso(180));
  const s3 = insSite.run('ST-S3', ar, 'Surgery center', '210 Vista Ridge', 'wet', dOff(240), 'deficiencies', iso(180), iso(180));
  const insEq = db.prepare(`INSERT INTO equipment (st_id, site_id, kind, count, due_at, st_updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const eqRows: [number, string, number][] = [
    [Number(s1.lastInsertRowid), 'heads', 214], [Number(s1.lastInsertRowid), 'extinguishers', 38], [Number(s1.lastInsertRowid), 'backflow', 1],
    [Number(s2.lastInsertRowid), 'heads', 46], [Number(s2.lastInsertRowid), 'extinguishers', 9],
    [Number(s3.lastInsertRowid), 'heads', 88], [Number(s3.lastInsertRowid), 'hood', 1],
  ];
  eqRows.forEach((e, i) => insEq.run('ST-E' + i, e[0], e[1], e[2], dOff(19), iso(180)));

  const insCon = db.prepare(
    `INSERT INTO contacts (st_id, account_id, name, role, email, phone, is_primary, is_billing, source, st_updated_at, local_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insCon.run('ST-C1', ar, 'Marcy Delgado', 'Facilities', 'marcy.d@maplewood.example', '(512) 555-0177', 1, 0, 'servicetrade', iso(180), iso(180));
  insCon.run('ST-C2', ar, 'Ron Beltran', 'Accounts payable', 'ron.beltran@maplewood.example', '(512) 555-0180', 0, 1, 'call', iso(180), iso(20));

  // timeline (verbatim from the design)
  const events: [string, string, string, string, string, number][] = [
    ['CALL', 'Marcy called about the invoice', 'Asked for a copy of #4471 and said it is "with the committee". Front desk logged the promise and set a callback for Monday.', 'Front Desk agent', '1:12 · recording saved', 120],
    ['$', 'Final notice drafted, waiting on you', '$34,800 · 98 days · third attempt. Escalates to a service pause if unanswered by Monday.', 'Invoice Collector', 'in your approval inbox', 130],
    ['JOB', 'Quarterly inspection completed - main plaza', '214 heads checked, 4 deficiencies found: 2 painted heads, 1 obstructed, 1 corroded pipe hanger.', 'ServiceTrade', 'job #88214 · tech R. Blake', 63360],
    ['QTE', 'Deficiency repair quote sent', '$22,900 for the surgery center items. Opened twice, no reply yet - Estimating Follow-up is on it.', 'ServiceTrade ↔ here', 'quote #Q-2291', 60480],
    ['★', 'Marcy left a 5-star Google review', '"Techs showed up when they said they would… paperwork was in my inbox the same afternoon."', 'Review Collector', 'reply drafted, awaiting approval', 4320],
    ['SYN', 'Billing contact changed on both sides', 'ServiceTrade says ap@maplewood.example; the call today said Ron Beltran. Sitting in the conflict queue.', 'Sync', 'needs a decision', 20],
  ];
  const insEv = db.prepare(
    `INSERT INTO account_events (account_id, tag, title, body, source, meta, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  events.forEach((e) => insEv.run(ar, e[0], e[1], e[2], e[3], e[4], iso(e[5])));

  // ---- pipeline quotes (the visible deals; stage counts/totals are headline fixtures in the route) ----
  // customer, title(detail), amount$, stage, origin, opened_count, sentDaysAgo, snoozeDays, lost_reason
  const quotes: [string, string, number, string, string, number, number | null, number | null, string | null][] = [
    ['Northgate Federal Campus annex', 'Annual inspection · 3 buildings', 18000, 'lead', 'call', 0, null, null, null],
    ['Mi Tierra (Market Sq)', 'Hood suppression re-cert', 7400, 'lead', 'call', 0, null, null, null],
    ['Maplewood Medical Plaza', '2 deficiencies · surgery center', 22900, 'quoted', 'deficiency', 0, 5, null, null],
    ['Live Oak Distribution Center', 'Dry system upgrade', 61500, 'quoted', 'manual', 3, 2, null, null],
    ['Culebra Medical Group', 'Backflow replacement', 14200, 'quoted', 'deficiency', 0, 1, null, null],
    ['Stone Oak Retail Partners', 'Called back twice · asked for Sept', 38600, 'following_up', 'call', 2, 9, null, null],
    ['Bulverde Self Storage', 'Waiting on their board · check 15 Aug', 9800, 'following_up', 'manual', 0, 12, 20, null],
    ['Northside ISD', 'Warehouse 4 · scheduled 04 Aug', 26400, 'won', 'deficiency', 0, 20, null, null],
    ['Converse Fleet Services', 'Extinguisher contract renewed', 12300, 'won', 'manual', 0, 25, null, null],
    ['Helotes Plaza', 'Went with incumbent · price', 8200, 'lost', 'manual', 1, 30, null, 'price'],
  ];
  const insQ = db.prepare(
    `INSERT INTO quotes (st_id, account_id, number, title, amount_cents, stage, origin, opened_count, sent_at, snooze_until, lost_reason, st_updated_at, local_updated_at, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clean')`
  );
  quotes.forEach((q, i) => {
    insQ.run('ST-Q' + i, accId[q[0]] ?? null, 'Q-' + (2280 + i), q[1], q[2] * 100, q[3], q[4], q[5],
      q[6] == null ? null : dOff(-q[6]), q[7] == null ? null : dOff(q[7]), q[8], iso(180), iso(180));
  });

  // ---- sync objects (exact directions from the handoff) ----
  const objs: [string, string, string, string, string, number][] = [
    ['accounts', 'Customers & sites', 'Names, addresses, tags, segments', 'both', 'newest_wins', 908],
    ['equipment', 'Equipment & inspections', 'Systems, devices, due dates, results', 'in', 'st_wins', 14220],
    ['jobs', 'Jobs & appointments', 'Scheduled work, techs, completion', 'in', 'st_wins', 1904],
    ['quotes', 'Quotes & deficiencies', 'Amounts, stages, win/loss reasons', 'both', 'newest_wins', 39],
    ['invoices', 'Invoices & payments', 'Balances, aging, paid dates', 'in', 'st_wins', 23],
    ['contacts', 'Contacts & notes', 'People, roles, call notes, promises', 'both', 'newest_wins', 1166],
    ['agent_output', 'Calls, leads & reviews', 'Everything the agents produce', 'out', 'local_owns', 96],
  ];
  const insObj = db.prepare(
    `INSERT INTO sync_objects (object, label, detail, direction, policy, enabled, record_count, last_pull_at, last_push_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
  );
  objs.forEach((o) => insObj.run(o[0], o[1], o[2], o[3], o[4], o[5], iso(2), iso(2)));

  // ---- conflicts (2) ----
  const insCf = db.prepare(
    `INSERT INTO sync_conflicts (object, local_id, st_id, field, their_value, their_updated_at, our_value, our_updated_at, our_origin, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
  );
  insCf.run('contacts', ar, 'ST-C2', 'billing_email', 'ap@maplewood.example', iso(120), 'ron.beltran@maplewood.example', iso(20), 'from a call');
  insCf.run('quotes', accId['Stone Oak Retail Partners'], 'ST-Q5', 'stage', 'Quote sent', iso(180), 'Following up · asked for Sept', iso(60), 'from a call');

  // ---- sync log (6, most-recent first) ----
  const logs: [string, string, string, number][] = [
    ['in', 'Job #88301 completed - Bulverde Self Storage', 'applied', 4],
    ['out', 'Call note + callback task on Maplewood', 'accepted', 5],
    ['out', 'New lead: Northgate Federal Campus annex (from a call)', 'created #41955', 15],
    ['both', 'Billing email on Maplewood', 'conflict', 31],
    ['in', 'Full cycle: 412 customers, 39 quotes, 23 invoices', '2.4s', 46],
    ['out', 'Quote stage → following up (Stone Oak)', 'queued', 48],
  ];
  const insLog = db.prepare(`INSERT INTO sync_log (direction, text, state, object, at) VALUES (?, ?, ?, ?, ?)`);
  logs.forEach((l) => insLog.run(l[0], l[1], l[2], null, iso(l[3])));

  setState('seeded_crm', '1');
  console.log('[seed] CRM + sync shell seeded (11 accounts, Maplewood detail, 10 quotes, 7 sync objects, 2 conflicts, 6 log rows).');
}

/**
 * The five cross-industry agents (Signal five-agents delta) as rows in `agents` so the team
 * view renders 11 and the roster picks them up. Own flag so existing brains (already past
 * seedAgents) upgrade in place. Their dedicated screens/engines land in later phases; here
 * they exist as team members whose "Open" points at their (soon) screen. */
function seedFiveAgents(): void {
  if (getState('seeded_five_agents') === '1') return;
  const db = getDb();
  const five: { key: string; name: string; role: string; pillar: string; capability_id: string; knowledge: string[] }[] = [
    { key: 'estimator', name: 'The Estimator', role: 'Turns photos or plans into a priced, traceable quote', pillar: 'sales', capability_id: 'estimator', knowledge: ['Read a takeoff from photos or a blueprint with per-item confidence', 'Price every line from the rate card so the quote is traceable'] },
    { key: 'closer', name: 'The Closer', role: 'Follows every open quote until it books or dies, on a cadence', pillar: 'sales', capability_id: 'closer', knowledge: ['Chase on a cadence: day 1 nudge, day 3 value, day 7 last call', 'Log why every lost quote was lost'] },
    { key: 'dispatch', name: 'The Dispatcher', role: 'Schedules jobs to crews, cuts no-shows, backfills cancellations', pillar: 'service', capability_id: 'dispatch', knowledge: ['Match a job to the right crew by skill, zone and capacity', 'Backfill a cancellation from the waitlist'] },
    { key: 'plans', name: 'The Service-Plan Manager', role: 'Turns jobs into recurring agreements, schedules visits, renews before they lapse', pillar: 'service', capability_id: 'plans', knowledge: ['Turn a finished job into a recurring service agreement', 'Renew an agreement before it lapses'] },
    { key: 'costing', name: 'Job Costing', role: 'Tracks real cost against the quote per job, flags margin bleed', pillar: 'finance', capability_id: 'costing', knowledge: ['Track logged labour, material and subs against the quote', 'Flag a job whose margin is bleeding below target'] },
  ];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO agents (key, name, role, pillar_key, capability_id, knowledge, origin, status)
     VALUES (?, ?, ?, ?, ?, ?, 'founding', 'live')`
  );
  const skillIns = db.prepare(`INSERT INTO agent_skills (agent_key, skill) VALUES (?, ?)`);
  for (const a of five) {
    const r = ins.run(a.key, a.name, a.role, a.pillar, a.capability_id, JSON.stringify(a.knowledge));
    if (r.changes) for (const s of a.knowledge) skillIns.run(a.key, s);
  }
  setState('seeded_five_agents', '1');
  console.log('[seed] five cross-industry agents seeded (team view now shows 11).');
}

/**
 * The Estimator takeoffs (five-agents Phase 2). Northgate Federal Campus (the active, flagged read with
 * the full item list that prices to $17,402) plus three in the queue. Own flag. */
function seedEstimator(): void {
  if (getState('seeded_estimator') === '1') return;
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO takeoffs (customer, address, source, asset_count, scale_ref, items_json, confidence, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const roll = (items: TakeoffItem[]) => items.reduce((s, i) => s + i.confidence, 0) / items.length;

  // Northgate Federal Campus annex - the active takeoff (must be id 1 so the quote reads #Q-2304).
  ins.run(
    SAMPLE_TAKEOFF.customer, SAMPLE_TAKEOFF.address, SAMPLE_TAKEOFF.source, SAMPLE_TAKEOFF.asset_count,
    SAMPLE_TAKEOFF.scale_ref, JSON.stringify(SAMPLE_TAKEOFF.items), roll(SAMPLE_TAKEOFF.items), 'flagged'
  );

  // The queue - one representative item each drives the descriptor + badge.
  const queue: { customer: string; source: string; assets: number; item: TakeoffItem; status: string }[] = [
    { customer: 'Mi Tierra (Market Sq)', source: 'photos', assets: 8, status: 'read',
      item: { item: 'Hood suppression', where: 'Kitchen line', count: 1, unit: 'system', confidence: 0.9 } },
    { customer: 'Helotes Crossing - Bldg C', source: 'blueprint', assets: 3, status: 'flagged',
      item: { item: 'New construction rough-in', where: 'Sheet A-3', count: 1, unit: 'system', confidence: 0.68, flag: 'low scale confidence' } },
    { customer: 'Converse Fleet Services', source: 'photos', assets: 21, status: 'read',
      item: { item: 'Extinguisher recount', where: 'All bays', count: 21, unit: 'units', confidence: 0.94 } },
  ];
  for (const q of queue) {
    ins.run(q.customer, null, q.source, q.assets, null, JSON.stringify([q.item]), q.item.confidence, q.status);
  }

  setState('seeded_estimator', '1');
  console.log('[seed] Estimator takeoffs seeded (Northgate Federal Campus + 3 in queue).');
}

/**
 * The Closer (five-agents Phase 3). Logs the last-90-days lost reasons (the "why we lose"
 * distribution - price 14, incumbent 8, budget 6, too slow 3, none 2) and ages one open
 * quote to day 7 so the right-rail last-call draft has a subject. Own flag. */
function seedCloser(): void {
  if (getState('seeded_closer') === '1') return;
  const db = getDb();

  // lost_reasons is keyed by quote_id but carries no FK; synthetic ids stand in for the
  // 33 hard-no's over the last 90 days so the panel counts are real.
  const dist: [string, number][] = [['price', 14], ['incumbent', 8], ['budget_cycle', 6], ['too_slow', 3], ['none', 2]];
  const insLost = db.prepare(`INSERT OR IGNORE INTO lost_reasons (quote_id, reason) VALUES (?, ?)`);
  let synth = -1;
  for (const [reason, n] of dist) for (let i = 0; i < n; i++) insLost.run(synth--, reason);

  // Age the Maplewood surgery-center quote to day 7 so it reads as a last-call.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  db.prepare(`UPDATE quotes SET sent_at = ? WHERE title LIKE '%surgery center%'`).run(sevenDaysAgo);

  setState('seeded_closer', '1');
  console.log('[seed] Closer seeded (33 lost reasons; one quote aged to last-call).');
}

/**
 * Service plans (five-agents Phase 4). Six active agreements matching the design, with
 * Boerne lapsing in 12 days (drives the right-rail renewal draft). Own flag. */
function seedPlans(): void {
  if (getState('seeded_plans') === '1') return;
  const db = getDb();
  const iso = (offDays: number) => new Date(Date.now() + offDays * 86400000).toISOString().slice(0, 10);
  // customer, plan_type, interval_days, price$, startYear, nextVisitOff, renewsOff
  const rows: [string, string, number, number, number, number, number][] = [
    ['Boerne Industrial Park LLC', 'Annual inspection · 9 sites', 365, 14400, 2012, 56, 12],
    ['Northside ISD', 'Quarterly inspection · 14 sites', 90, 58800, 2009, 7, 158],
    ['Maplewood Medical Plaza', 'Quarterly sprinkler · 3 sites', 90, 24600, 2014, 17, 65],
    ['Culebra Medical Group', 'Annual + backflow · 4 sites', 365, 11200, 2017, 36, 22],
    ['Converse Fleet Services', 'Quarterly extinguisher route', 90, 9600, 2016, 14, 217],
    ['Live Oak Distribution Center', 'Annual + backflow · 2 sites', 365, 7300, 2021, 15, 125],
  ];
  const ins = db.prepare(
    `INSERT INTO service_agreements (customer, plan_type, interval_days, price, status, started_at, next_service_at, renews_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
  );
  for (const r of rows) ins.run(r[0], r[1], r[2], r[3], `${r[4]}-01-01`, iso(r[5]), iso(r[6]));

  setState('seeded_plans', '1');
  console.log('[seed] service plans seeded (6 agreements; Boerne lapsing in 12 days).');
}

/**
 * The Dispatcher (five-agents Phase 5). Four crews with distinct skills/zones/loads, a week of
 * confirmed appointments across Mon-Fri, the one proposed slot (Northgate Federal Campus annex → Crew B,
 * Wed 8 to 12) that drives the right-rail proposal, and a 7-deep waitlist. Appointments are stored
 * by day-of-week so the grid always reads as "this week". Own flag. */
function seedDispatch(): void {
  if (getState('seeded_dispatch') === '1') return;
  const db = getDb();

  // crews: name, skills(csv), zone, capacity/day, load%
  const crews: [string, string, string, number, number][] = [
    ['Crew A', 'sprinkler,backflow', 'North', 3, 92],
    ['Crew B', 'clearance,sprinkler', 'Northeast', 3, 74],
    ['Crew C', 'alarm,hood', 'Central', 3, 88],
    ['Crew D', 'extinguisher', 'West', 3, 56],
  ];
  const insCrew = db.prepare(`INSERT INTO crews (name, skills, zone, capacity_per_day, load_pct) VALUES (?, ?, ?, ?, ?)`);
  const crewId: Record<string, number> = {};
  for (const c of crews) crewId[c[0]] = Number(insCrew.run(c[0], c[1], c[2], c[3], c[4]).lastInsertRowid);

  // appointments: crew, customer, skill, dow(0=Mon..4=Fri), window, status
  // Crew B keeps Wed as the proposed Northgate Federal Campus slot and Thursday deliberately open.
  const appts: [string, string, string, number, string, string][] = [
    ['Crew A', 'Maplewood Plaza', 'sprinkler', 0, '8 to 12', 'confirmed'],
    ['Crew A', 'Live Oak DC', 'backflow', 1, '8 to 11', 'confirmed'],
    ['Crew A', 'Stone Oak Retail', 'sprinkler', 2, '1 to 4', 'confirmed'],
    ['Crew A', 'Northside ISD #4', 'sprinkler', 3, '8 to 12', 'confirmed'],
    ['Crew A', 'Boerne Ind - Bldg 1', 'backflow', 4, '8 to 11', 'confirmed'],
    ['Crew B', 'Converse Fleet', 'clearance', 0, '9 to 12', 'confirmed'],
    ['Crew B', 'Helotes Crossing', 'sprinkler', 1, '1 to 4', 'confirmed'],
    ['Crew B', 'Northgate Federal Campus annex', 'clearance', 2, '8 to 12', 'proposed'],
    ['Crew B', 'Schertz Medical', 'clearance', 4, '8 to 11', 'confirmed'],
    ['Crew C', 'Mi Tierra (Market Sq)', 'hood', 0, '8 to 11', 'confirmed'],
    ['Crew C', 'Market Sq Grill', 'hood', 1, '8 to 12', 'confirmed'],
    ['Crew C', 'La Cantera Mall', 'alarm', 2, '9 to 12', 'confirmed'],
    ['Crew C', 'Rim Shopping Center', 'alarm', 3, '1 to 4', 'confirmed'],
    ['Crew C', 'Bulverde Storage', 'hood', 4, '8 to 11', 'confirmed'],
    ['Crew D', 'Converse Bays', 'extinguisher', 0, '1 to 3', 'confirmed'],
    ['Crew D', 'Bandera Rd store', 'extinguisher', 2, '8 to 10', 'confirmed'],
    ['Crew D', 'Leon Valley Depot', 'extinguisher', 4, '1 to 3', 'confirmed'],
  ];
  const insAppt = db.prepare(`INSERT INTO appointments (crew_id, customer, skill, dow, window, status) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const a of appts) insAppt.run(crewId[a[0]], a[1], a[2], a[3], a[4], a[5]);

  // waitlist: rank, customer, need, skill, flexibility (top 3 match the design)
  const wait: [number, string, string, string, string][] = [
    [1, 'Culebra Medical Group', 'Sprinkler repair · asked for "any day"', 'sprinkler', 'any day'],
    [2, 'Bandera Rd store', 'Alarm panel · called today', 'alarm', 'this week'],
    [3, 'Boerne Industrial - Bldg 3', 'Annual · flexible until Sept', 'sprinkler', 'until Sept'],
    [4, 'Schertz Auto Group', 'Extinguisher route · new customer', 'extinguisher', 'flexible'],
    [5, 'Cibolo Town Center', 'Backflow test · overdue', 'backflow', 'this month'],
    [6, 'Northgate Plaza', 'Hood re-cert · code deadline', 'hood', 'by month-end'],
    [7, 'Selma Crossing', 'Alarm inspection · annual', 'alarm', 'flexible'],
  ];
  const insWait = db.prepare(`INSERT INTO waitlist (rank, customer, need, skill, flexibility) VALUES (?, ?, ?, ?, ?)`);
  for (const w of wait) insWait.run(w[0], w[1], w[2], w[3], w[4]);

  setState('seeded_dispatch', '1');
  console.log('[seed] Dispatcher seeded (4 crews, a week of jobs, Northgate Federal Campus proposed, 7 on waitlist).');
}

/**
 * Job Costing (five-agents Phase 6). Every job's margin is COMPUTED on read, so the seed only
 * carries the raw costs. Numbers are chosen so the live compute reproduces the design: five
 * in-progress jobs bleed, Bulverde extinguishers is the 61% best, and Northside ISD - Warehouse
 * 4 lands at -4% (quoted $26,400; 214 labour hrs vs 160 quoted; $7,910 material; $1,140 sub),
 * the anchor for the right-rail breakdown + change order. Own flag. */
function seedCosting(): void {
  if (getState('seeded_costing') === '1') return;
  const db = getDb();
  // customer, work, quoted$, laborHrs, quotedHrs, material$, sub$, subLabel, status, note
  const jobs: [string, string, number, number, number, number, number, string | null, string, string][] = [
    ['La Cantera Mall', 'Alarm upgrade - Phase 2', 31200, 300, 250, 6800, 1200, 'monitoring tie-in', 'in_progress', 'Labor 50 hrs over'],
    ['Helotes Crossing', 'New construction rough-in', 19800, 190, 150, 4200, 900, 'fire pump test', 'in_progress', 'Labor 40 hrs over'],
    ['Northside ISD', 'Warehouse 4', 26400, 214, 160, 7910, 1140, 'backflow cert', 'in_progress', 'Labor 54 hrs over'],
    ['Stone Oak Retail', 'Extinguisher recharge', 8400, 74, 60, 2600, 0, null, 'in_progress', 'Material ran high'],
    ['Converse Fleet', 'Quarterly route', 9600, 96, 84, 1900, 0, null, 'in_progress', 'Labor 12 hrs over'],
    ['Maplewood Plaza', 'Quarterly sprinkler', 24600, 120, 130, 5200, 800, 'backflow cert', 'in_progress', 'On plan'],
    ['Bulverde Self Storage', 'Extinguisher service', 4200, 12, 14, 600, 0, null, 'closed', 'Clean route'],
    ['Boerne Industrial', 'Annual inspection', 14400, 80, 90, 3100, 0, null, 'closed', 'On plan'],
    ['Live Oak DC', 'Annual + backflow', 7300, 40, 44, 1400, 0, null, 'closed', 'On plan'],
    ['Mi Tierra (Market Sq)', 'Hood re-cert', 2400, 10, 12, 700, 0, null, 'closed', 'Quick turn'],
  ];
  const ins = db.prepare(
    `INSERT INTO job_costs (customer, work, quoted_cents, labor_hrs, labor_quoted_hrs, material_cents, sub_cents, sub_label, status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const j of jobs) ins.run(j[0], j[1], j[2] * 100, j[3], j[4], j[5] * 100, j[6] * 100, j[7], j[8], j[9]);

  setState('seeded_costing', '1');
  console.log('[seed] Job Costing seeded (10 jobs; Northside Warehouse 4 bleeding at -4%).');
}
