import { Router } from 'express';
import { getDb } from '../db/index';
import { draftInvoiceReminder, getReceivablesSummary, daysOverdue, Invoice } from '../services/invoiceAgent';
import {
  nudgeInvoice,
  scheduleReminders,
  getReminderTimeline,
  sendReminderRow,
  Channel,
} from '../services/reminderWorkflow';
import { syncFromServiceTrade } from '../services/serviceTrade';
import { integrationConnected } from '../config/integrations';
import { REMINDER_STEPS, resendEnabled, telnyxEnabled } from '../config/comms';

const router = Router();

/** Dashboard data: summary + invoice list + reminder queue + per-invoice timelines. */
router.get('/api/invoices', (_req, res) => {
  const db = getDb();
  const invoices = (db.prepare(`SELECT * FROM invoices ORDER BY (status='paid'), due_at`).all() as Invoice[]).map(
    (inv) => ({ ...inv, days_overdue: daysOverdue(inv) })
  );
  const reminders = db
    .prepare(
      `SELECT r.*, i.customer, i.amount FROM invoice_reminders r JOIN invoices i ON i.id = r.invoice_id
       WHERE r.status IN ('draft','approved','queued','failed') ORDER BY r.created_at DESC`
    )
    .all();

  // Per-invoice reminder timelines (day-1/3/5/7 steps + manual nudges), keyed by invoice id.
  const steps = db
    .prepare(
      `SELECT id, invoice_id, tier, channel, step, status, scheduled_for, sent_at, error
         FROM invoice_reminders WHERE step > 0 ORDER BY invoice_id, step`
    )
    .all() as { invoice_id: number }[];
  const timelines: Record<number, unknown[]> = {};
  for (const s of steps) (timelines[s.invoice_id] ||= []).push(s);

  res.json({
    summary: getReceivablesSummary(),
    invoices,
    reminders,
    timelines,
    cadence: REMINDER_STEPS,
    channels: { email: resendEnabled(), sms: telnyxEnabled() },
    live: integrationConnected('servicetrade') || integrationConnected('stripe'),
  });
});

/** Draft a reminder (gated — creates a draft awaiting approval). Legacy single-shot draft. */
router.post('/api/invoices/:id/draft-reminder', async (req, res) => {
  try {
    const r = await draftInvoiceReminder(Number(req.params.id));
    res.json({ ok: true, reminder: r });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Manual nudge — draft + send one reminder now via email or SMS (queues if comms aren't live). */
router.post('/api/invoices/:id/nudge', async (req, res) => {
  try {
    const channel = (req.body?.channel === 'sms' ? 'sms' : 'email') as Channel;
    const r = await nudgeInvoice(Number(req.params.id), channel);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Arm (or re-arm) the automatic day-1/3/5/7 sequence for an invoice. */
router.post('/api/invoices/:id/schedule-reminders', (req, res) => {
  try {
    const r = scheduleReminders(Number(req.params.id));
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** The reminder timeline for one invoice. */
router.get('/api/invoices/:id/timeline', (req, res) => {
  res.json({ ok: true, timeline: getReminderTimeline(Number(req.params.id)) });
});

/** Toggle auto-reminders for an invoice on/off. */
router.post('/api/invoices/:id/auto-remind', (req, res) => {
  const on = req.body?.on === false ? 0 : 1;
  getDb().prepare(`UPDATE invoices SET auto_remind = ? WHERE id = ?`).run(on, Number(req.params.id));
  if (on) scheduleReminders(Number(req.params.id));
  res.json({ ok: true, auto_remind: on });
});

/** Approve a drafted/queued reminder — actually sends it if a channel is live. */
router.post('/api/invoices/reminders/:id/approve', async (req, res) => {
  try {
    const r = await sendReminderRow(Number(req.params.id));
    res.json({ ok: true, ...r, sent: r.status === 'sent' });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Mark an invoice paid (manual reconcile until QuickBooks/Stripe are wired). */
router.post('/api/invoices/:id/mark-paid', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  db.prepare(`UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).run(id);
  // Stop chasing a paid bill — cancel its still-scheduled reminders.
  db.prepare(`UPDATE invoice_reminders SET status = 'skipped' WHERE invoice_id = ? AND status = 'scheduled'`).run(id);
  res.json({ ok: true });
});

/** Manual ServiceTrade pull — backfills open invoices + arms sequences (no-op without token). */
router.post('/api/invoices/sync', async (_req, res) => {
  const r = await syncFromServiceTrade();
  res.json({ ok: true, ...r });
});

export default router;
