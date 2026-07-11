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

  /* ---------- invoices (~12 across aging buckets) ---------- */
  const invoices: [string, string, number, number, string][] = [
    // customer, email, amount, dueOffsetDays(negative=overdue), status
    ['Lone Star Logistics', 'ap@lonestarlog.com', 4820.0, -8, 'sent'],
    ['Brazos Valley Church', 'admin@bvchurch.org', 1250.0, -3, 'reminded'],
    ['Hilltop Apartments LLC', 'billing@hilltopapts.com', 3600.0, -22, 'sent'],
    ['Cypress Retail Group', 'finance@cypressretail.com', 9750.0, -45, 'reminded'],
    ['Alamo Self Storage', 'owner@alamostorage.com', 780.0, -12, 'sent'],
    ['Gulf Coast Manufacturing', 'ap@gcmfg.com', 15200.0, -67, 'reminded'],
    ['Redbud Medical Plaza', 'billing@redbudmed.com', 5400.0, -35, 'sent'],
    ['Trinity School District', 'ap@trinityisd.org', 2100.0, -95, 'reminded'],
    ['Pecan Grove HOA', 'board@pecangrovehoa.org', 640.0, -5, 'sent'],
    ['Westfield Warehouse', 'accounts@westfieldwh.com', 8300.0, -120, 'reminded'],
    ['Bluebonnet Bakery', 'hello@bluebonnetbakery.com', 410.0, -18, 'sent'],
    ['Rio Grande Auto', 'shop@riograndeauto.com', 1950.0, -2, 'sent'],
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
  insPaid.run('Eastside Fitness', 'gm@eastsidefit.com', 2200.0, daysAgo(40), daysAgo(10), daysAgo(4));
  insPaid.run('Magnolia Offices', 'ap@magnoliaoffices.com', 3100.0, daysAgo(50), daysAgo(20), daysAgo(9));

  /* ---------- jobs (completed → request queue) ---------- */
  const jobs: [string, string][] = [
    ['Lone Star Logistics', 'Annual sprinkler inspection & tag'],
    ['Brazos Valley Church', 'Backflow preventer test'],
    ['Hilltop Apartments LLC', 'Fire alarm panel service'],
    ['Alamo Self Storage', 'Dry system trip test'],
    ['Redbud Medical Plaza', 'Quarterly inspection'],
    ['Pecan Grove HOA', 'Clubhouse extinguisher recharge'],
    ['Bluebonnet Bakery', 'Kitchen hood suppression check'],
    ['Rio Grande Auto', 'New sprinkler heads install'],
  ];
  const insJob = db.prepare(
    `INSERT INTO jobs (customer, job_desc, completed_at, requested) VALUES (?, ?, ?, 0)`
  );
  jobs.forEach((j, i) => insJob.run(j[0], j[1], daysAgo(i + 2)));

  /* ---------- reviews (mostly 4-5★, a couple 3★) ---------- */
  const reviews: [string, string, number, string, number][] = [
    ['google', 'Marcus T.', 5, 'Showed up on time, explained everything, and got our system tagged same day. Highly recommend.', 6],
    ['google', 'Priya S.', 5, 'These folks really do go anywhere — drove two hours to our site without blinking. Professional crew.', 11],
    ['google', 'Dave R.', 4, 'Good work on our backflow test. Took a little longer than quoted but the quality was there.', 15],
    ['yelp', 'Angela M.', 5, 'Lifesavers, literally. Caught a code issue our last company missed for years.', 21],
    ['google', 'Tomás L.', 3, 'Job got done but scheduling was a bit of a runaround. The tech himself was great.', 28],
    ['facebook', 'Karen W.', 5, 'Licensed, insured, and they actually pick up the phone. Rare these days.', 33],
    ['google', 'Sam P.', 4, 'Solid inspection, clear report. Would use again.', 40],
    ['yelp', 'Nina H.', 3, 'Pricing was fair but I had to follow up twice for the paperwork.', 47],
    ['google', 'Reggie B.', 5, '108 years of experience shows. Knew our old system inside and out.', 55],
  ];
  const insRev = db.prepare(
    `INSERT INTO reviews (source, author, stars, text, received_at, reply_status) VALUES (?, ?, ?, ?, ?, 'none')`
  );
  for (const [source, author, stars, text, dago] of reviews) {
    insRev.run(source, author, stars, text, daysAgo(dago));
  }

  /* ---------- calls + leads (receptionist demo) ---------- */
  const calls: [string, number, string, string, string, number][] = [
    // from, duration, intent, outcome, transcript, minsAgo
    ['+1 512 555 0142', 184, 'inspection request', 'booked', 'Caller needs an annual sprinkler inspection for a warehouse in Round Rock. Booked for next Tuesday.', 22],
    ['+1 210 555 0199', 96, 'service call', 'message', "Caller reported a leaking sprinkler head at a retail store. Took a message for the service team.", 65],
    ['+1 713 555 0111', 240, 'new install quote', 'transferred', 'Caller wants a quote for a new sprinkler system in a 40k sqft facility. Transferred to a specialist.', 130],
    ['+1 469 555 0176', 58, 'general question', 'message', 'Caller asked about backflow testing requirements. Provided info, took callback details.', 200],
    ['+1 361 555 0188', 152, 'emergency', 'transferred', 'After-hours: alarm going off at a medical plaza. Flagged as emergency and transferred immediately.', 300],
  ];
  const insCall = db.prepare(
    `INSERT INTO calls (from_number, started_at, duration, transcript, intent, outcome) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const [from, dur, intent, outcome, transcript, mins] of calls) {
    insCall.run(from, isoAgo(mins), dur, transcript, intent, outcome);
  }

  const leads: [string, string, string, string, string][] = [
    ['Round Rock Warehouse Co.', '+1 512 555 0142', '1200 Industrial Blvd, Round Rock, TX', 'Annual sprinkler inspection', 'booked'],
    ['Maria Gonzalez', '+1 210 555 0199', '480 Market St, San Antonio, TX', 'Leaking sprinkler head — service', 'new'],
    ['Houston Facility Group', '+1 713 555 0111', '900 Bayou Dr, Houston, TX', 'New system install quote', 'contacted'],
    ['Redbud Medical Plaza', '+1 361 555 0188', '77 Wellness Way, Corpus Christi, TX', 'After-hours alarm — emergency', 'contacted'],
  ];
  const insLead = db.prepare(
    `INSERT INTO leads (name, phone, address, need, status, source) VALUES (?, ?, ?, ?, ?, 'phone')`
  );
  for (const [name, phone, address, need, status] of leads) {
    insLead.run(name, phone, address, need, status);
  }

  /* ---------- a few seed brain rules ---------- */
  const insRule = db.prepare(`INSERT INTO rules (rule, scope) VALUES (?, ?)`);
  insRule.run('Never quote a price on a call — capture details and let a specialist confirm.', 'receptionist');
  insRule.run('Nothing sends without human approval: reminders, review replies, and requests are drafts.', 'global');
  insRule.run('Emergencies and out-of-scope calls transfer to a human immediately.', 'receptionist');

  setState('seeded', '1');
  console.log('[seed] sample data loaded (invoices, jobs, reviews, calls, leads).');
}
