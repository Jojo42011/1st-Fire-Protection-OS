import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';

/**
 * Idempotent seed — guarded by a system_state flag so every dashboard looks alive on first
 * boot (standalone-until-connected). Safe to call on every boot; only runs once.
 */
export function seed(): void {
  if (getState('seeded') === '1') return;
  const db = getDb();

  const daysAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const isoAgo = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();

  /* ---------- invoices (~12 across aging buckets) — real Texas customers + service lines ---------- */
  const invoices: [string, string, string, number, number, string][] = [
    // customer, email, phone, amount, dueOffsetDays(negative=overdue), status
    ['Alamo Heights ISD', 'ap@ahisd.example', '+1 210 555 0210', 4820.0, -8, 'sent'],           // sprinkler inspection
    ['Riverwalk Hospitality Group', 'billing@rwhg.example', '+1 210 555 0231', 1250.0, -3, 'reminded'], // hood suppression
    ['Buda Logistics Park', 'ap@budalogistics.example', '+1 512 555 0244', 3600.0, -22, 'sent'], // alarm service
    ['South Texas Medical Center', 'finance@stmc.example', '+1 210 555 0257', 9750.0, -45, 'reminded'], // fire pump test
    ['Laredo Self Storage', 'owner@laredostore.example', '+1 956 555 0268', 780.0, -12, 'sent'], // extinguisher recharge
    ['Gulf Coast Manufacturing', 'ap@gcmfg.example', '+1 361 555 0279', 15200.0, -67, 'reminded'], // sprinkler install
    ['Waco Retail Plaza', 'billing@wacoretail.example', '+1 254 555 0281', 5400.0, -35, 'sent'], // quarterly inspection
    ['Lubbock County Facilities', 'ap@lubbockco.example', '+1 806 555 0293', 2100.0, -95, 'reminded'], // backflow test
    ['Pecan Grove HOA', 'board@pecangrovehoa.example', '+1 281 555 0305', 640.0, -5, 'sent'],   // extinguishers
    ['Spring Industrial Warehouse', 'accounts@springwh.example', '+1 281 555 0316', 8300.0, -120, 'reminded'], // hydrotest
    ['McAllen Bakery Co.', 'hello@mcallenbakery.example', '+1 956 555 0327', 410.0, -18, 'sent'], // kitchen suppression
    ['College Station Auto', 'shop@cstxauto.example', '+1 979 555 0338', 1950.0, -2, 'sent'],     // emergency lighting
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
