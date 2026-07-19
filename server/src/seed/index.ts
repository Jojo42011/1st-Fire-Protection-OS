import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { PILLARS } from '../config/auditor';
import { DEPARTMENTS } from '../config/departments';
import { COMPANY } from '../config/constants';

/**
 * Idempotent seed — guarded by a system_state flag so every dashboard looks alive on first
 * boot (standalone-until-connected). Safe to call on every boot; only runs once.
 */
export function seed(): void {
  // The audit foundation + sample content run on their own flags so existing brains
  // (already seeded) still pick them up on upgrade.
  ensureAuditFoundation();
  seedAudit();
  seedGrowth();
  seedQuestions();
  seedAgents();
  seedHarness();

  if (getState('seeded') === '1') return;
  const db = getDb();

  const daysAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const isoAgo = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();

  /* ---------- invoices (16 across aging buckets, ~$3.5M outstanding) — real Texas customers + service lines ---------- */
  const invoices: [string, string, string, number, number, string][] = [
    // customer, email, phone, amount, dueOffsetDays(negative=overdue), status
    ['Alamo Heights ISD', 'ap@ahisd.example', '+1 210 555 0210', 48200.0, -8, 'sent'],            // district-wide sprinkler inspection & tag
    ['Riverwalk Hospitality Group', 'billing@rwhg.example', '+1 210 555 0231', 62500.0, -3, 'reminded'], // hood suppression — 9 properties
    ['College Station Auto Group', 'ap@cstxautogroup.example', '+1 979 555 0338', 19500.0, -2, 'sent'],  // emergency lighting & exit signage
    ['Pecan Grove HOA', 'board@pecangrovehoa.example', '+1 281 555 0305', 6400.0, -5, 'sent'],     // clubhouse & amenity extinguishers
    ['Frost Data Center (Austin)', 'ap@frostdc.example', '+1 512 555 0412', 128000.0, -12, 'sent'], // tenant fit-out pre-action sprinkler
    ['Waco Retail Plaza', 'billing@wacoretail.example', '+1 254 555 0281', 54000.0, -22, 'sent'],  // quarterly inspection — sprinkler & alarm
    ['Buda Logistics Park', 'ap@budalogistics.example', '+1 512 555 0244', 87300.0, -28, 'reminded'], // fire alarm panel upgrade
    ['Museum District Tower (Houston)', 'finance@mdtower.example', '+1 713 555 0455', 210000.0, -35, 'reminded'], // high-rise standpipe & pump ITM
    ['Laredo Distribution Center', 'ap@laredodist.example', '+1 956 555 0268', 36000.0, -42, 'sent'], // dry system service
    ['South Texas Medical Center', 'finance@stmc.example', '+1 210 555 0257', 397500.0, -45, 'reminded'], // fire pump replacement & test
    ['Lubbock County Facilities', 'ap@lubbockco.example', '+1 806 555 0293', 145000.0, -58, 'reminded'], // backflow & sprinkler retrofit
    ['Gulf Coast Manufacturing', 'ap@gcmfg.example', '+1 361 555 0279', 425000.0, -67, 'reminded'], // new sprinkler system install
    ['McAllen Convention Center', 'ap@mcallencc.example', '+1 956 555 0327', 96000.0, -78, 'reminded'], // alarm system modernization
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
    ['Alamo Heights ISD', 'Annual fire sprinkler inspection & tag'],
    ['Riverwalk Hospitality Group', 'Kitchen hood suppression semi-annual service'],
    ['Buda Logistics Park', 'Fire alarm panel service call'],
    ['Laredo Self Storage', 'Dry system trip test'],
    ['Waco Retail Plaza', 'Quarterly inspection — sprinkler & alarm'],
    ['Pecan Grove HOA', 'Clubhouse extinguisher recharge'],
    ['McAllen Bakery Co.', 'Kitchen hood suppression check'],
    ['College Station Auto', 'Emergency lighting & exit sign test'],
  ];
  const insJob = db.prepare(
    `INSERT INTO jobs (customer, job_desc, completed_at, requested) VALUES (?, ?, ?, 0)`
  );
  jobs.forEach((j, i) => insJob.run(j[0], j[1], daysAgo(i + 2)));

  /* ---------- reviews (mostly 4-5★, a couple 3★) — Google + Facebook ---------- */
  const reviews: [string, string, number, string, number][] = [
    ['google', 'Marcus T.', 5, 'Showed up on time, explained everything, and got our sprinkler system tagged same day. White-glove all the way.', 6],
    ['google', 'Priya S.', 5, 'Drove down from San Antonio to our Laredo site without blinking. Single-source for all our life safety now.', 11],
    ['google', 'Dave R.', 4, 'Good work on our backflow test. Took a little longer than quoted but the quality was there.', 15],
    ['facebook', 'Angela M.', 5, 'Lifesavers, literally. Their inspector caught an alarm code issue our last company missed for years.', 21],
    ['google', 'Tomás L.', 3, 'Job got done but scheduling was a bit of a runaround. The tech himself was great.', 28],
    ['facebook', 'Karen W.', 5, 'Licensed, insured, HUB-certified, and they actually pick up the phone. Rare these days.', 33],
    ['google', 'Sam P.', 4, 'Solid annual inspection, clear report. Would use again for our Waco property.', 40],
    ['google', 'Nina H.', 3, 'Pricing was fair but I had to follow up twice for the ITM paperwork.', 47],
    ['google', 'Reggie B.', 5, '108 years of combined experience shows. Knew our old fire pump inside and out.', 55],
  ];
  const insRev = db.prepare(
    `INSERT INTO reviews (source, author, stars, text, received_at, reply_status) VALUES (?, ?, ?, ?, ?, 'none')`
  );
  for (const [source, author, stars, text, dago] of reviews) {
    insRev.run(source, author, stars, text, daysAgo(dago));
  }

  /* ---------- calls + leads (receptionist demo) — real SA routing outcomes ---------- */
  const calls: [string, number, string, string, string, number][] = [
    // from, duration, intent, outcome, transcript, minsAgo
    ['+1 210 555 0142', 184, 'Inspection request', 'transferred', 'Caller needs an annual sprinkler inspection for a warehouse near San Antonio. Routed to Inspections group (Kelsey Bovard / Mel Vela).', 22],
    ['+1 210 555 0199', 96, 'Sprinkler service', 'transferred', 'Leaking sprinkler head at a retail store. Routed to Fire Sprinkler Service (Ronnie Blue).', 65],
    ['+1 210 555 0111', 240, 'New install / bid', 'transferred', 'Wants a bid for a new sprinkler system in a 40k sqft facility. Routed to Sales (Clayton Cichon).', 130],
    ['+1 210 555 0176', 74, 'Billing', 'transferred', 'Caller wants to pay an invoice. Routed to Accounting group.', 155],
    ['+1 210 555 0188', 152, 'Emergency', 'transferred', 'After-hours: alarm going off at a medical plaza. Flagged emergency → After-hours on-call queue.', 200],
    ['+1 210 555 0155', 63, 'Complaint', 'transferred', 'Upset about a missed appointment window. Empathized, did not argue — routed straight to Daniel Rodriguez.', 240],
    ['+1 210 555 0133', 88, 'Spanish-speaking', 'message', 'Spanish caller needing extinguisher recharge. Helped in Spanish, took name/number/reason — Denise to route.', 300],
  ];
  const insCall = db.prepare(
    `INSERT INTO calls (from_number, started_at, duration, transcript, intent, outcome) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const [from, dur, intent, outcome, transcript, mins] of calls) {
    insCall.run(from, isoAgo(mins), dur, transcript, intent, outcome);
  }

  const leads: [string, string, string, string, string][] = [
    ['Northside Warehouse Co.', '+1 210 555 0142', '1200 Industrial Blvd, San Antonio, TX', 'Annual sprinkler inspection', 'booked'],
    ['Maria Gonzalez', '+1 210 555 0199', '480 Market St, San Antonio, TX', 'Leaking sprinkler head — service', 'new'],
    ['Hill Country Facility Group', '+1 210 555 0111', '900 Bandera Rd, San Antonio, TX', 'New sprinkler system — bid', 'contacted'],
    ['Southtown Medical Plaza', '+1 210 555 0188', '77 Wellness Way, San Antonio, TX', 'After-hours alarm — emergency', 'contacted'],
    ['José Ramírez', '+1 210 555 0133', 'McAllen, TX', 'Extinguisher recharge (Spanish)', 'new'],
  ];
  const insLead = db.prepare(
    `INSERT INTO leads (name, phone, address, need, status, source) VALUES (?, ?, ?, ?, ?, 'phone')`
  );
  for (const [name, phone, address, need, status] of leads) {
    insLead.run(name, phone, address, need, status);
  }

  /* ---------- a few seed brain rules (the real SA routing logic) ---------- */
  const insRule = db.prepare(`INSERT INTO rules (rule, scope) VALUES (?, ?)`);
  insRule.run('Never quote a price on a call — capture details and route to Sales/Ops.', 'receptionist');
  insRule.run('Mario Salinas (President) → send to voicemail every time. Do not transfer.', 'receptionist');
  insRule.run('Any complaint → do not handle it; route straight to Daniel Rodriguez, empathetic, no arguing.', 'receptionist');
  insRule.run('Spanish-speaking caller → help in Spanish, do NOT transfer; capture name/number/reason for callback.', 'receptionist');
  insRule.run('Emergency / alarm now / after-hours → After-hours on-call queue immediately.', 'receptionist');
  insRule.run('Nothing sends without human approval: reminders, review replies, and requests are drafts.', 'global');

  setState('seeded', '1');
  console.log('[seed] sample data loaded (invoices, jobs, reviews, calls, leads).');
}

/**
 * Audit foundation — the structural skeleton (pillars + the 9 real locations).
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
  // Ed Portillo is Vendor Relations — was filed under sales before vendors existed.
  db.prepare(`UPDATE audit_people SET pillar_key = 'vendors' WHERE name = 'Ed Portillo'`).run();
  db.prepare(`DELETE FROM audit_pillars WHERE key IN ('dispatch','compliance','people')`).run();

  const insPillar = db.prepare(
    `INSERT OR IGNORE INTO audit_pillars (key, name, tagline, sort) VALUES (?, ?, ?, ?)`
  );
  PILLARS.forEach((p, i) => insPillar.run(p.key, p.name, p.tagline, i));

  const insLoc = db.prepare(`INSERT OR IGNORE INTO audit_locations (name, role) VALUES (?, ?)`);
  COMPANY.locations.forEach((name, i) => insLoc.run(name, i === 0 ? 'HQ' : 'branch'));
}

/**
 * Audit sample content — pre-loads what we already know about 1st FP (real stack, real
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
    ['Vapi + Twilio (this OS)', 'voice', 'The San Antonio line — AI receptionist', '', 'reception'],
    ['Spreadsheets', 'spreadsheet', 'The real coordination layer between systems', 'Manually re-keyed from ServiceTrade; nine local versions of the truth', 'finance'],
  ];
  const insSys = db.prepare(
    `INSERT INTO audit_systems (name, category, truth_for, gaps, pillar_key) VALUES (?, ?, ?, ?, ?)`
  );
  for (const s of systems) insSys.run(...s);

  /* the veterans we already know by name (from the routing brain) */
  const people: [string, string, string, string, string, string][] = [
    // name, role, location, carries, risk, pillar
    ['Daniel Rodriguez', 'Operations Manager', 'San Antonio', 'Every complaint and unclassifiable call routes through him — the escalation brain', 'high', 'ops'],
    ['Kelsey Bovard', 'Inspections Scheduling', 'San Antonio', 'Holds the inspection calendar and AHJ scheduling quirks', 'high', 'inspections'],
    ['Ronnie Blue', 'Sprinkler Service Manager', 'San Antonio', 'Sprinkler service triage and crew knowledge', 'medium', 'service'],
    ['Matt Shaner', 'Fire Alarm Service Manager', 'San Antonio', 'Alarm service triage; panel/system history by account', 'medium', 'service'],
    ['Ed Portillo', 'Vendor Relations', 'San Antonio', 'Supplier relationships and pricing history', 'medium', 'vendors'],
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
      'Systematic shops convert 30–50% of deficiencies into paid repairs; informal handling leaves that revenue on the table.',
      'high', '30–50% of repair revenue', 'deficiency_pipeline'],
    ['sales', 'leak', 'Repair quotes take days to go out after an inspection',
      'Quotes sent within 24h convert 2–3× better than week-old quotes. Turnaround is the #1 conversion lever.',
      'high', '2–3× conversion delta', 'quote_drafter'],
    ['finance', 'leak', 'Receivables chased by hand, invoices go out late',
      '~60% of contractor invoices are paid late; manual invoicing adds 15–30 days of DSO.',
      'high', '15–30 days of DSO', 'invoice_chaser'],
    ['ops', 'gap', 'Nine locations, no side-by-side view of the same numbers',
      'Each branch runs its own way; variance is invisible until it becomes a problem. One brain over all nine is the consolidation play.',
      'medium', '', 'location_command'],
  ];
  const insFnd = db.prepare(
    `INSERT INTO audit_findings (pillar_key, kind, title, detail, severity, cost_hint, capability_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const f of findings) insFnd.run(...f);

  // San Antonio is where the audit starts — HQ is touched by definition.
  db.prepare(`UPDATE audit_locations SET mapped = 1 WHERE role = 'HQ'`).run();

  setState('seeded_audit', '1');
  console.log('[seed] audit foundation loaded (pillars, locations, known systems, veterans, benchmark leaks).');
}

/**
 * Growth intelligence — context fed in from Booker Growth's Texas fire-protection market
 * research so The Operator walks in already seeing the GROWTH gaps, not just operational
 * leaks. Illustrative/benchmark findings (no invented accounts); the real targets come
 * from the public feeds (SFMO license DB, permits, bid boards) when connected. Own flag so
 * existing brains pick it up on upgrade.
 */
function seedGrowth(): void {
  if (getState('seeded_growth') === '1') return;
  const db = getDb();

  // the public feeds that power expansion — a "system of record" the OS should mine
  db.prepare(
    `INSERT INTO audit_systems (name, category, truth_for, gaps, pillar_key) VALUES (?, ?, ?, ?, ?)`
  ).run(
    'SFMO License DB + Permit Portals + Bid Boards',
    'public-data',
    'Texas competitor map, new-construction signal, and competitively-bid contracts',
    'All public and free, none of it mined today — competitor/white-space map, acquisition targets, permit-to-ITM signal, and ISD/municipal RFPs are unused',
    'growth'
  );

  const findings: [string, string, string, string, string, string, string][] = [
    // pillar, kind, title, detail, severity, cost_hint, capability
    ['growth', 'gap', 'New-construction permits that become ITM accounts are not captured systematically',
      'Every new commercial building is a code-mandated future inspection account. Catching the permit and timing outreach to the acceptance test converts installs into decades of recurring ITM; today it is relationship-driven, not systematic.',
      'high', 'future recurring ITM', 'permit_hunter'],
    ['growth', 'leak', 'Installs and one-off repairs are not converted into recurring agreements',
      'Recurring ITM mix is the master value driver — operators at 40%+ recurring trade 2–3 EBITDA turns higher. Every completed install/one-off without an agreement is recurring revenue left on the table.',
      'high', '2–3 EBITDA turns', 'recurring_capture'],
    ['growth', 'gap', 'Competitor and white-space map lives in people\'s heads, not on a board',
      'The Texas SFMO publishes every licensed fire contractor. Mapped by metro it shows where coverage is thin (expansion white space) and which small shops are acquisition targets — density-first from San Antonio outward.',
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

  // An OFF-CATALOG gap: nothing in the build catalog covers fleet maintenance, but a
  // 9-location field-service company lives and dies by its trucks. The Operator proposes a
  // CUSTOM agent for it, so the harness can grow the team beyond the preset builds.
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

  setState('seeded_growth', '1');
  console.log('[seed] growth intelligence loaded (SFMO/permit/bid feeds + 5 growth gaps on the Growth pillar).');
}

/**
 * The interview ladder — seed each department's opening question deck (depth 0) so the
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
      knowledge: ['Answer in the 1st FP voice and never miss an after-hours emergency', 'Route inspections, service, and sales to the right desk'],
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
