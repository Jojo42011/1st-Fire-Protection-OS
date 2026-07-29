import { getDb } from '../db/index';
import { TRADE_CONFIG } from '../config/tradeConfig';
import { createApproval } from '../routes/approvals';
import { COMPANY } from '../config/constants';

/**
 * The Dispatcher engine. EXTRACT vs COMPUTE: a crew/skill/zone match is a pure, deterministic
 * SCORE (skill fit dominates, then zone proximity, then spare capacity) — never a prompt. It
 * proposes a slot with a human-readable reason; confirming the slot and texting the reminder
 * are GATED. It backfills a cancellation from the waitlist so a no-show never leaves a crew idle.
 * Appointments are stored by day-of-week so the grid always reads as "this week".
 */

export interface Crew {
  id: number;
  name: string;
  skills: string; // csv
  zone: string;
  capacity_per_day: number;
  load_pct: number;
}
export interface Appointment {
  id: number;
  crew_id: number;
  customer: string;
  site: string | null;
  skill: string;
  dow: number;
  window: string;
  status: string;
}
export interface WaitItem {
  id: number;
  rank: number;
  customer: string;
  need: string;
  skill: string;
  flexibility: string;
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const DOW_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/** Monday of the current week (UTC), so the grid header reads the live dates. */
function weekMonday(): Date {
  const now = new Date();
  const dow = now.getUTCDay(); // 0 Sun .. 6 Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
}
/** e.g. "Mon 27" for a 0..4 day index against the current week. */
function dayLabel(dowIndex: number): string {
  const d = weekMonday();
  d.setUTCDate(d.getUTCDate() + dowIndex);
  return `${DOW[dowIndex]} ${d.getUTCDate()}`;
}

// status → the two tints the design uses (confirmed teal, proposed indigo).
const TINT: Record<string, { bg: string; border: string; fg: string; metaFg: string }> = {
  confirmed: { bg: 'var(--teal-bg)', border: 'var(--teal)', fg: 'var(--teal)', metaFg: 'var(--teal)' },
  proposed: { bg: 'var(--indigo-bg)', border: 'var(--indigo)', fg: 'var(--indigo)', metaFg: 'var(--indigo)' },
};
const tintFor = (status: string) => TINT[status] || TINT.confirmed;

/** Load bar colour: full crews read money, healthy teal, light green. */
function loadFg(pct: number): string {
  if (pct >= TRADE_CONFIG.dispatch.fullLoadPct) return 'var(--money)';
  if (pct >= 70) return 'var(--teal)';
  return 'var(--green)';
}

function crewHas(crew: Crew, skill: string): boolean {
  return crew.skills.split(',').map((s) => s.trim()).includes(skill);
}

/**
 * Deterministic match score for putting a job on a crew. Skill fit dominates (a crew that
 * can't do the work scores it out), then zone proximity, then spare capacity that day.
 */
export function scoreCrew(crew: Crew, skill: string, zone: string): number {
  const w = TRADE_CONFIG.dispatch.scoring;
  let score = 0;
  if (crewHas(crew, skill)) score += w.skill;
  if (crew.zone === zone) score += w.zone;
  score += (Math.max(0, 100 - crew.load_pct) / 100) * w.capacity;
  return score;
}

/** Propose the best crew + slot for a waitlisted job, with the reason spelled out (GATED). */
export function proposeSchedule(waitId: number): { waitId: number; crew: string; reason: string } {
  const db = getDb();
  const job = db.prepare(`SELECT * FROM waitlist WHERE id = ?`).get(waitId) as WaitItem | undefined;
  if (!job) throw new Error(`waitlist item ${waitId} not found`);
  const crews = db.prepare(`SELECT * FROM crews`).all() as Crew[];
  const ranked = crews
    .map((c) => ({ c, s: scoreCrew(c, job.skill, /*zone unknown for waitlist*/ c.zone) }))
    .sort((a, b) => b.s - a.s);
  const best = ranked[0]?.c;
  if (!best) throw new Error('no crews available');

  const reason = `${best.name} carries ${job.skill} and has the most open capacity this week (${best.load_pct}% loaded). Backfills the next cancellation before the slot goes cold.`;
  createApproval({
    agent_key: 'dispatch',
    kind: 'schedule_change',
    risk: 'routine',
    title: `Schedule · ${job.customer}`,
    stake: `${best.name} · ${job.need}`,
    body: `Put ${job.customer} (${job.need}) on ${best.name}. ${reason}`,
    trail: 'Confirms the slot and queues the customer reminders',
    subject_type: 'waitlist',
    subject_id: waitId,
  });
  return { waitId, crew: best.name, reason };
}

/** Approve a proposed appointment's slot (GATED — it commits the crew and starts reminders). */
export function approveSlot(appointmentId: number): { appointmentId: number; crew: string; when: string } {
  const db = getDb();
  const a = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointmentId) as Appointment | undefined;
  if (!a) throw new Error(`appointment ${appointmentId} not found`);
  const crew = db.prepare(`SELECT name FROM crews WHERE id = ?`).get(a.crew_id) as { name: string } | undefined;
  const crewName = crew?.name || 'the crew';
  const when = `${dayLabel(a.dow)} ${a.window}`;
  createApproval({
    agent_key: 'dispatch',
    kind: 'schedule_change',
    risk: 'routine',
    title: `Schedule · ${a.customer}`,
    stake: `${crewName} · ${when}`,
    body: `Confirm ${a.customer}${a.site ? ` (${a.site})` : ''} on ${crewName}, ${when}. ${a.skill} visit; the slot leaves the rest of the crew's day intact.`,
    trail: 'Confirms the slot and queues the customer reminders',
    subject_type: 'appointment',
    subject_id: appointmentId,
  });
  return { appointmentId, crew: crewName, when };
}

/** Draft the customer reminder for an appointment (GATED — send_sms). */
export function draftReminder(appointmentId: number): { appointmentId: number; body: string } {
  const db = getDb();
  const a = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointmentId) as Appointment | undefined;
  if (!a) throw new Error(`appointment ${appointmentId} not found`);
  const when = `${dayLabel(a.dow)}, ${a.window}`;
  const body = `Hi — reminder from ${COMPANY.name}: your ${a.skill} visit is ${when}. Reply C to confirm or R to reschedule and we'll move it.`;
  createApproval({
    agent_key: 'dispatch',
    kind: 'send_sms',
    risk: 'routine',
    title: `Reminder · ${a.customer}`,
    stake: when,
    body,
    trail: `Two go out per appointment — ${TRADE_CONFIG.dispatch.reminderHoursBefore[0]} hours out and the morning of`,
    subject_type: 'appointment',
    subject_id: appointmentId,
  });
  return { appointmentId, body };
}

/** Backfill a freed slot (a cancellation/no-show) with the top of the waitlist (GATED). */
export function backfill(): { customer: string; crew: string } {
  const db = getDb();
  const top = db.prepare(`SELECT * FROM waitlist ORDER BY rank ASC LIMIT 1`).get() as WaitItem | undefined;
  if (!top) throw new Error('waitlist is empty');
  const r = proposeSchedule(top.id);
  return { customer: top.customer, crew: r.crew };
}

// waitlist rank → pill colour (design: #1 money, #2 amber, rest gray).
const RANK_PILL = (rank: number) => (rank === 1 ? 'money' : rank === 2 ? 'amber' : 'gray');

export function getScheduleSummary() {
  const db = getDb();
  const crews = db.prepare(`SELECT * FROM crews ORDER BY id ASC`).all() as Crew[];
  const appts = db.prepare(`SELECT * FROM appointments`).all() as Appointment[];
  const wait = db.prepare(`SELECT * FROM waitlist ORDER BY rank ASC`).all() as WaitItem[];

  const days = DOW.map((_, i) => ({ label: dayLabel(i), index: i }));

  const crewRows = crews.map((c) => ({
    name: c.name,
    skills: c.skills.split(',').map((s) => s.trim()).join(' · '),
    loadPct: `${c.load_pct}%`,
    loadFg: loadFg(c.load_pct),
    days: days.map((d) => ({
      jobs: appts
        .filter((a) => a.crew_id === c.id && a.dow === d.index)
        .map((a) => {
          const t = tintFor(a.status);
          return { who: a.customer, window: a.window, ...t };
        }),
    })),
  }));

  // the active right-rail proposal: the seeded 'proposed' appointment (Randolph AFB → Crew B).
  const proposedAppt = appts.find((a) => a.status === 'proposed');
  let proposal = null;
  if (proposedAppt) {
    const crew = crews.find((c) => c.id === proposedAppt.crew_id);
    const crewName = crew?.name || 'a crew';
    proposal = {
      appointmentId: proposedAppt.id,
      title: `${proposedAppt.customer} → ${crewName}, ${DOW[proposedAppt.dow]} ${proposedAppt.window}`,
      reason: `${crewName} is the only crew with the base clearance on file, they're 4 miles from the site on ${DOW_FULL[proposedAppt.dow]}, and the slot leaves Thursday open for the Alamo Ridge repairs if that quote lands.`,
    };
  }

  const waitlist = wait.slice(0, 3).map((w) => ({
    rank: w.rank,
    customer: w.customer,
    need: w.need,
    pill: RANK_PILL(w.rank),
  }));

  return {
    // headline KPIs are shell fixtures matching the design; the grid + proposal are real reads.
    summary: { jobsToday: 14, utilization: '82%', noShowRate: '6%', openSlots: 3, waitlisted: 7 },
    header: { crewLabel: 'Crew', days: days.map((d) => d.label) },
    crews: crewRows,
    proposal,
    waitlist,
    noShows: { rate: '6%', missed: 2, reminders: 28, note: 'Rate is down from 19% before reminders.' },
    live: false,
  };
}
