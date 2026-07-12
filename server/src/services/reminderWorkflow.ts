import { getDb } from '../db/index';
import { Invoice, draftReminder, tierFor, reminderSubject } from './invoiceAgent';
import { sendMessage } from './comms';
import { REMINDER_STEPS, tierForStep, channelLive } from '../config/comms';

/**
 * The Invoice Collector's reminder workflow.
 *
 * When a ServiceTrade job completes and its invoice is created, the sequence is armed:
 * reminders on day 1, 3, 5, 7 after completion, escalating friendly → firm → final.
 * An hourly sweep (runDueReminders) AI-drafts and sends whatever is due; a manual Nudge
 * button sends one immediately. Everything degrades gracefully — with no Resend/Telnyx key
 * a due reminder is drafted and left 'queued' for one-click human approval.
 */

export type Channel = 'email' | 'sms';

interface ReminderRow {
  id: number;
  invoice_id: number;
  tier: string;
  body: string;
  status: string;
  channel: Channel;
  step: number;
  scheduled_for: string | null;
  sent_at: string | null;
  provider: string | null;
  error: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/** base date the cadence counts from: job completion → issue date → today. */
function cadenceBase(inv: Invoice): string {
  return (inv.job_completed_at || inv.issued_at || today()).slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The channel the auto sequence uses for an invoice: email if we have one, else SMS. */
function primaryChannel(inv: Invoice): Channel | null {
  if (inv.email) return 'email';
  if (inv.phone) return 'sms';
  return null;
}

function recipientFor(inv: Invoice, channel: Channel): string | null {
  return channel === 'email' ? inv.email || null : inv.phone || null;
}

/**
 * Arm the day-1/3/5/7 sequence for an invoice (idempotent — the unique index on
 * (invoice_id, step, channel) means re-running never double-schedules). Returns how many
 * new steps were scheduled. No-op for paid invoices or ones with auto_remind off / no contact.
 */
export function scheduleReminders(invoiceId: number): { scheduled: number; channel: Channel | null } {
  const db = getDb();
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as Invoice | undefined;
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  if (inv.status === 'paid' || inv.auto_remind === 0) return { scheduled: 0, channel: null };

  const channel = primaryChannel(inv);
  if (!channel) return { scheduled: 0, channel: null };

  const base = cadenceBase(inv);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO invoice_reminders (invoice_id, tier, body, status, channel, step, scheduled_for)
     VALUES (?, ?, '', 'scheduled', ?, ?, ?)`
  );

  let scheduled = 0;
  for (const day of REMINDER_STEPS) {
    const { tier } = tierForStep(day);
    const info = insert.run(invoiceId, tier, channel, day, addDays(base, day));
    if (info.changes > 0) scheduled++;
  }
  return { scheduled, channel };
}

/** Draft (if needed) and attempt to send a single reminder row. Central send path. */
async function deliver(row: ReminderRow, inv: Invoice): Promise<'sent' | 'queued' | 'failed'> {
  const db = getDb();
  const { tone } = tierFor(row.tier === 'final' ? 30 : row.tier === 'firm' ? 14 : 1);

  // Draft the body lazily, at send time, so it reflects the latest tone/tier.
  let body = row.body;
  let subject = reminderSubject(inv, row.tier);
  if (!body) {
    const drafted = await draftReminder(inv, row.tier, tone, row.channel);
    body = drafted.body;
    subject = drafted.subject;
    db.prepare('UPDATE invoice_reminders SET body = ? WHERE id = ?').run(body, row.id);
  }

  const to = recipientFor(inv, row.channel);
  if (!to) {
    db.prepare(`UPDATE invoice_reminders SET status = 'failed', error = ? WHERE id = ?`).run(
      `no ${row.channel} on file`,
      row.id
    );
    return 'failed';
  }

  // Graceful degradation: no key for this channel → leave it queued for human approval.
  if (!channelLive(row.channel)) {
    db.prepare(`UPDATE invoice_reminders SET status = 'queued', provider = 'none' WHERE id = ?`).run(row.id);
    return 'queued';
  }

  const result = await sendMessage(row.channel, to, subject, body);
  if (result.sent) {
    db.prepare(
      `UPDATE invoice_reminders SET status = 'sent', sent_at = datetime('now'), provider = ?, provider_id = ?, error = NULL WHERE id = ?`
    ).run(result.provider, result.id || null, row.id);
    db.prepare(
      `UPDATE invoices SET status = 'reminded', last_reminder_at = datetime('now') WHERE id = ? AND status != 'paid'`
    ).run(inv.id);
    return 'sent';
  }

  db.prepare(`UPDATE invoice_reminders SET status = 'failed', provider = ?, error = ? WHERE id = ?`).run(
    result.provider,
    result.error || 'send failed',
    row.id
  );
  return 'failed';
}

/**
 * The hourly cron sweep. Sends every scheduled reminder whose date has arrived, skips the
 * remaining steps on invoices that got paid, and drafts+queues when comms aren't live.
 */
export async function runDueReminders(): Promise<{
  sent: number;
  queued: number;
  failed: number;
  skipped: number;
}> {
  const db = getDb();
  const out = { sent: 0, queued: 0, failed: 0, skipped: 0 };

  // 1) Any invoice now paid → skip its still-scheduled steps (stop chasing a paid bill).
  const skip = db
    .prepare(
      `UPDATE invoice_reminders SET status = 'skipped'
         WHERE status = 'scheduled'
           AND invoice_id IN (SELECT id FROM invoices WHERE status = 'paid')`
    )
    .run();
  out.skipped = skip.changes;

  // 2) Due, still-scheduled reminders for unpaid, auto-enrolled invoices.
  const due = db
    .prepare(
      `SELECT r.* FROM invoice_reminders r
         JOIN invoices i ON i.id = r.invoice_id
        WHERE r.status = 'scheduled'
          AND r.step > 0
          AND date(r.scheduled_for) <= date('now')
          AND i.status != 'paid'
          AND COALESCE(i.auto_remind, 1) = 1
        ORDER BY r.scheduled_for`
    )
    .all() as ReminderRow[];

  for (const row of due) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(row.invoice_id) as Invoice | undefined;
    if (!inv) continue;
    const result = await deliver(row, inv);
    out[result]++;
  }
  return out;
}

/**
 * Manual nudge from the portal — draft + send one reminder right now (step 0). Chooses the
 * tier from how overdue the invoice is. Sends if the channel is live, otherwise queues it.
 */
export async function nudgeInvoice(
  invoiceId: number,
  channel: Channel
): Promise<{ id: number; status: string; channel: Channel }> {
  const db = getDb();
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as Invoice | undefined;
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);

  const to = recipientFor(inv, channel);
  if (!to) throw new Error(`invoice ${invoiceId} has no ${channel} on file`);

  const days = daysOverdueSafe(inv);
  const { tier, tone } = tierFor(days);
  const { body } = await draftReminder(inv, tier, tone, channel);

  const info = db
    .prepare(
      `INSERT INTO invoice_reminders (invoice_id, tier, body, status, channel, step, scheduled_for)
       VALUES (?, ?, ?, 'scheduled', ?, 0, date('now'))`
    )
    .run(invoiceId, tier, body, channel);
  const id = Number(info.lastInsertRowid);

  // body is already drafted; deliver() re-derives the subject and just sends/queues it.
  const row = db.prepare('SELECT * FROM invoice_reminders WHERE id = ?').get(id) as ReminderRow;
  const status = await deliver(row, inv);
  return { id, status, channel };
}

/** Send (or re-send) a specific queued/approved reminder row — used by the Approve & Send button. */
export async function sendReminderRow(reminderId: number): Promise<{ status: string }> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM invoice_reminders WHERE id = ?').get(reminderId) as ReminderRow | undefined;
  if (!row) throw new Error(`reminder ${reminderId} not found`);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(row.invoice_id) as Invoice | undefined;
  if (!inv) throw new Error(`invoice ${row.invoice_id} not found`);
  const status = await deliver(row, inv);
  return { status };
}

/** The reminder timeline for one invoice — powers the per-invoice schedule view. */
export function getReminderTimeline(invoiceId: number): ReminderRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM invoice_reminders WHERE invoice_id = ? ORDER BY (step = 0), step, scheduled_for`
    )
    .all(invoiceId) as ReminderRow[];
}

/** daysOverdue that tolerates a paid/missing due date (avoids importing the private one). */
function daysOverdueSafe(inv: Invoice): number {
  if (!inv.due_at || inv.status === 'paid') return 0;
  const due = new Date(inv.due_at + 'T00:00:00Z').getTime();
  return Math.max(0, Math.floor((Date.now() - due) / 86400000));
}
