import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { PILLARS } from '../config/auditor';
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

  if (getState('seeded') === '1') return;
  const db = getDb();

  const daysAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const isoAgo = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();

  /* ---------- invoices (~12 across aging buckets) — real Texas customers + service lines ---------- */
  const invoices: [string, string, number, number, string][] = [
    // customer, email, amount, dueOffsetDays(negative=overdue), status
    ['Alamo Heights ISD', 'ap@ahisd.example', 4820.0, -8, 'sent'],           // sprinkler inspection
    ['Riverwalk Hospitality Group', 'billing@rwhg.example', 1250.0, -3, 'reminded'], // hood suppression
    ['Buda Logistics Park', 'ap@budalogistics.example', 3600.0, -22, 'sent'], // alarm service
    ['South Texas Medical Center', 'finance@stmc.example', 9750.0, -45, 'reminded'], // fire pump test
    ['Laredo Self Storage', 'owner@laredostore.example', 780.0, -12, 'sent'], // extinguisher recharge
    ['Gulf Coast Manufacturing', 'ap@gcmfg.example', 15200.0, -67, 'reminded'], // sprinkler install
    ['Waco Retail Plaza', 'billing@wacoretail.example', 5400.0, -35, 'sent'], // quarterly inspection
    ['Lubbock County Facilities', 'ap@lubbockco.example', 2100.0, -95, 'reminded'], // backflow test
    ['Pecan Grove HOA', 'board@pecangrovehoa.example', 640.0, -5, 'sent'],   // extinguishers
    ['Spring Industrial Warehouse', 'accounts@springwh.example', 8300.0, -120, 'reminded'], // hydrotest
    ['McAllen Bakery Co.', 'hello@mcallenbakery.example', 410.0, -18, 'sent'], // kitchen suppression
    ['College Station Auto', 'shop@cstxauto.example', 1950.0, -2, 'sent'],     // emergency lighting
  ];
  const insInv = db.prepare(
    `INSERT INTO invoices (customer, email, amount, issued_at, due_at, status) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const [customer, email, amount, dueOff, status] of invoices) {
    insInv.run(customer, email, amount, daysAgo(-dueOff + 30), daysAgo(-dueOff), status);
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
    ['Microsoft 365 / Teams', 'comms', 'Email, call transfers, office coordination', 'Call outcomes live in chat threads, not in a system', 'dispatch'],
    ['Vapi + Twilio (this OS)', 'voice', 'The San Antonio line — AI receptionist', '', 'dispatch'],
    ['Spreadsheets', 'spreadsheet', 'The real coordination layer between systems', 'Manually re-keyed from ServiceTrade; nine local versions of the truth', 'finance'],
  ];
  const insSys = db.prepare(
    `INSERT INTO audit_systems (name, category, truth_for, gaps, pillar_key) VALUES (?, ?, ?, ?, ?)`
  );
  for (const s of systems) insSys.run(...s);

  /* the veterans we already know by name (from the routing brain) */
  const people: [string, string, string, string, string, string][] = [
    // name, role, location, carries, risk, pillar
    ['Daniel Rodriguez', 'Operations Manager', 'San Antonio', 'Every complaint and unclassifiable call routes through him — the escalation brain', 'high', 'people'],
    ['Kelsey Bovard', 'Inspections Scheduling', 'San Antonio', 'Holds the inspection calendar and AHJ scheduling quirks', 'high', 'inspections'],
    ['Ronnie Blue', 'Sprinkler Service Manager', 'San Antonio', 'Sprinkler service triage and crew knowledge', 'medium', 'service'],
    ['Matt Shaner', 'Fire Alarm Service Manager', 'San Antonio', 'Alarm service triage; panel/system history by account', 'medium', 'service'],
    ['Ed Portillo', 'Vendor Relations', 'San Antonio', 'Supplier relationships and pricing history', 'medium', 'sales'],
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
    ['growth', 'gap', 'Nine locations, no side-by-side view of the same numbers',
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
