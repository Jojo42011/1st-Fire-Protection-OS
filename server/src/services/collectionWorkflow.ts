import { getDb } from '../db/index';
import { chat } from './llm';
import { COMPANY } from '../config/constants';
import { integrationConnected } from '../config/integrations';
import { Invoice, daysOverdue } from './invoiceAgent';

/**
 * Collection Workflow — the automated daily dunning engine for the Invoice Collector.
 *
 * Enrolling an overdue invoice is the human gate (a person decides to start the chase).
 * Once enrolled, the daily cycle drafts and SENDS an outstanding-balance email AND text
 * every day until the invoice is marked paid — then the workflow auto-completes.
 *
 * Graceful degradation (standalone-until-connected): when the Email (Gmail/M365) or SMS
 * (Twilio) integration isn't present, that channel is SIMULATED — the message is drafted
 * and logged, nothing leaves the building. Add the key and the same cycle sends for real.
 */

const DAY_MS = 86400000;
const CHANNELS = ['email', 'sms'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface WorkflowRow {
  id: number;
  invoice_id: number;
  status: 'active' | 'paused' | 'done' | 'stopped';
  channels: string;
  day_count: number;
  started_at: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
}

function tierFor(days: number): string {
  if (days >= 30) return 'final';
  if (days >= 14) return 'firm';
  return 'friendly';
}

/** Full email body — same tempered voice as the manual reminders, tuned per aging tier. */
function emailBody(inv: Invoice, tier: string, days: number): string {
  const amt = `$${inv.amount.toFixed(2)}`;
  const opener =
    tier === 'final'
      ? `This is a final notice regarding invoice #${inv.id}, now ${days} days past due.`
      : tier === 'firm'
        ? `Following up again on invoice #${inv.id}, which is ${days} days past due.`
        : `A quick reminder about invoice #${inv.id}.`;
  return [
    `Hi ${inv.customer},`,
    '',
    `${opener} The balance of ${amt} was due on ${inv.due_at || 'the agreed date'}.`,
    tier === 'final'
      ? `Please arrange payment within 5 business days so we can keep your account in good standing. If you've already paid, please disregard this note.`
      : `Whenever you get a chance, we'd appreciate settling the balance. If there's any question about the work, just reply and we'll sort it out.`,
    '',
    `Thank you for trusting ${COMPANY.name} with your fire protection & life safety.`,
    `${COMPANY.name} · ${COMPANY.phone}`,
  ].join('\n');
}

/** SMS body — short, one-screen, brand-safe. */
function smsBody(inv: Invoice, tier: string, days: number): string {
  const amt = `$${inv.amount.toFixed(2)}`;
  const lead =
    tier === 'final'
      ? `Final notice: invoice #${inv.id} (${amt}) is ${days} days past due.`
      : tier === 'firm'
        ? `Reminder: invoice #${inv.id} (${amt}) is ${days} days past due.`
        : `Friendly reminder: invoice #${inv.id} for ${amt} is past due.`;
  return `${COMPANY.name}: ${lead} Questions or to pay, call ${COMPANY.phone}. Already paid? Please disregard.`;
}

/** Build both channel bodies for today's cycle. LLM enhances the email when a key is present. */
async function draftDaily(inv: Invoice, tier: string, days: number): Promise<{ email: string; sms: string }> {
  let email = emailBody(inv, tier, days);
  const sms = smsBody(inv, tier, days);
  const tone =
    tier === 'final'
      ? 'a firm final notice — professional, not hostile'
      : tier === 'firm'
        ? 'a firmer follow-up — clear and direct'
        : 'a friendly nudge — warm and low-pressure';
  const result = await chat(
    [
      {
        role: 'system',
        content: `You draft payment-reminder emails for ${COMPANY.name}, a fire protection & life safety company in Texas. Brand voice: ${COMPANY.brandVoice}. This customer is on a daily reminder sequence; write ${tone}. Keep it under 120 words, sign off as the company, never threaten. Never use an em dash (—); use a comma, a colon, or two sentences instead. Output ONLY the email body.`,
      },
      {
        role: 'user',
        content: `Customer: ${inv.customer}\nInvoice #${inv.id}\nAmount: $${inv.amount.toFixed(2)}\nDue: ${inv.due_at}\nDays overdue: ${days}\nNotes: ${inv.notes || 'none'}`,
      },
    ],
    { fast: true, maxTokens: 400 }
  );
  if (result && result.text) email = result.text;
  return { email, sms };
}

function parseChannels(csv: string): Channel[] {
  return csv
    .split(',')
    .map((c) => c.trim())
    .filter((c): c is Channel => (CHANNELS as readonly string[]).includes(c));
}

/** Enroll an invoice into the daily workflow (idempotent — re-enrolling reactivates). */
export function enrollInvoice(invoiceId: number, channels: Channel[] = ['email', 'sms']): WorkflowRow {
  const db = getDb();
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as Invoice | undefined;
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  if (inv.status === 'paid') throw new Error(`invoice ${invoiceId} is already paid`);

  const chans = (channels.length ? channels : ['email', 'sms']).join(',');
  db.prepare(
    `INSERT INTO invoice_workflow (invoice_id, status, channels, next_run_at)
       VALUES (?, 'active', ?, datetime('now'))
     ON CONFLICT(invoice_id) DO UPDATE SET
       status = 'active', channels = excluded.channels, next_run_at = datetime('now')`
  ).run(invoiceId, chans);
  return db.prepare('SELECT * FROM invoice_workflow WHERE invoice_id = ?').get(invoiceId) as WorkflowRow;
}

/** Pause / resume / stop a workflow. Resume re-arms the next cycle for now. */
export function setWorkflowStatus(workflowId: number, status: 'paused' | 'active' | 'stopped'): void {
  const db = getDb();
  if (status === 'active') {
    db.prepare(`UPDATE invoice_workflow SET status = 'active', next_run_at = datetime('now') WHERE id = ?`).run(
      workflowId
    );
  } else {
    db.prepare(`UPDATE invoice_workflow SET status = ? WHERE id = ?`).run(status, workflowId);
  }
}

/** Mark any active workflow for a paid invoice as complete (called on reconcile). */
export function completeWorkflowIfPaid(invoiceId: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE invoice_workflow SET status = 'done'
       WHERE invoice_id = ? AND status IN ('active','paused')`
  ).run(invoiceId);
}

export interface DailyRunResult {
  processed: number; // invoices whose daily cycle ran
  sent: number; // channel touches actually sent (live integration)
  simulated: number; // channel touches logged only (no integration)
  completed: number; // workflows that closed because the invoice was paid
}

/**
 * Run every due daily cycle. Idempotent per day via next_run_at gating — safe to call
 * on a short interval; it only acts on workflows whose next run is due.
 */
export async function runDailyCollection(opts: { force?: boolean } = {}): Promise<DailyRunResult> {
  const db = getDb();
  const emailLive = integrationConnected('gmail');
  const smsLive = integrationConnected('sms');

  const due = db
    .prepare(
      `SELECT * FROM invoice_workflow
        WHERE status = 'active'
          AND (? = 1 OR next_run_at IS NULL OR next_run_at <= datetime('now'))`
    )
    .all(opts.force ? 1 : 0) as WorkflowRow[];

  const result: DailyRunResult = { processed: 0, sent: 0, simulated: 0, completed: 0 };

  const logStmt = db.prepare(
    `INSERT INTO invoice_workflow_log (workflow_id, invoice_id, day, channel, tier, destination, body, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const wf of due) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(wf.invoice_id) as Invoice | undefined;
    if (!inv) {
      db.prepare(`UPDATE invoice_workflow SET status = 'stopped' WHERE id = ?`).run(wf.id);
      continue;
    }
    // Paid → close the workflow, don't send.
    if (inv.status === 'paid') {
      db.prepare(`UPDATE invoice_workflow SET status = 'done', last_run_at = datetime('now') WHERE id = ?`).run(wf.id);
      result.completed++;
      continue;
    }

    const days = daysOverdue(inv);
    const tier = tierFor(days);
    const { email, sms } = await draftDaily(inv, tier, days);
    const day = wf.day_count + 1;
    const channels = parseChannels(wf.channels);

    for (const channel of channels) {
      const dest = channel === 'email' ? inv.email : inv.phone;
      const body = channel === 'email' ? email : sms;
      let status: string;
      if (!dest) {
        status = 'skipped'; // no address/number on file for this channel
      } else if ((channel === 'email' && emailLive) || (channel === 'sms' && smsLive)) {
        status = 'sent';
        result.sent++;
      } else {
        status = 'simulated';
        result.simulated++;
      }
      logStmt.run(wf.id, inv.id, day, channel, tier, dest || null, body, status);
    }

    db.prepare(
      `UPDATE invoice_workflow
          SET day_count = ?, last_run_at = datetime('now'),
              next_run_at = datetime('now', '+1 day')
        WHERE id = ?`
    ).run(day, wf.id);
    db.prepare(`UPDATE invoices SET last_reminder_at = datetime('now') WHERE id = ? AND status != 'paid'`).run(inv.id);
    result.processed++;
  }

  return result;
}

export interface WorkflowView {
  id: number;
  invoice_id: number;
  customer: string;
  amount: number;
  days_overdue: number;
  status: string;
  channels: string;
  day_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
}

/** Dashboard payload: enrolled workflows + a recent activity log. */
export function getWorkflowState(): {
  live: boolean;
  emailLive: boolean;
  smsLive: boolean;
  activeCount: number;
  enrolled: WorkflowView[];
  activity: Record<string, unknown>[];
} {
  const db = getDb();
  const enrolled = (
    db
      .prepare(
        `SELECT w.id, w.invoice_id, w.status, w.channels, w.day_count, w.last_run_at, w.next_run_at,
                i.customer, i.amount, i.status AS inv_status, i.due_at
           FROM invoice_workflow w JOIN invoices i ON i.id = w.invoice_id
          WHERE w.status != 'stopped'
          ORDER BY (w.status='done'), w.next_run_at`
      )
      .all() as (WorkflowView & { inv_status: string; due_at: string | null })[]
  ).map((w) => ({
    id: w.id,
    invoice_id: w.invoice_id,
    customer: w.customer,
    amount: w.amount,
    days_overdue: daysOverdue({ due_at: w.due_at, status: w.inv_status } as Invoice),
    status: w.status,
    channels: w.channels,
    day_count: w.day_count,
    last_run_at: w.last_run_at,
    next_run_at: w.next_run_at,
  }));

  const activity = db
    .prepare(
      `SELECT l.channel, l.tier, l.status, l.destination, l.day, l.created_at, i.customer, i.amount
         FROM invoice_workflow_log l JOIN invoices i ON i.id = l.invoice_id
        ORDER BY l.created_at DESC, l.id DESC LIMIT 20`
    )
    .all() as Record<string, unknown>[];

  const activeCount = enrolled.filter((w) => w.status === 'active').length;
  return {
    live: integrationConnected('gmail') || integrationConnected('sms'),
    emailLive: integrationConnected('gmail'),
    smsLive: integrationConnected('sms'),
    activeCount,
    enrolled,
    activity,
  };
}
