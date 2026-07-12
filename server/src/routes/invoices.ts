import { Router } from 'express';
import { getDb } from '../db/index';
import { draftInvoiceReminder, getReceivablesSummary, daysOverdue, Invoice } from '../services/invoiceAgent';
import {
  enrollInvoice,
  setWorkflowStatus,
  completeWorkflowIfPaid,
  runDailyCollection,
  getWorkflowState,
  Channel,
} from '../services/collectionWorkflow';
import { integrationConnected } from '../config/integrations';

const router = Router();

/** Dashboard data: summary + invoice list + reminder queue + collection workflow. */
router.get('/api/invoices', (_req, res) => {
  const db = getDb();
  const invoices = (db.prepare(`SELECT * FROM invoices ORDER BY (status='paid'), due_at`).all() as Invoice[]).map(
    (inv) => ({ ...inv, days_overdue: daysOverdue(inv) })
  );
  const reminders = db
    .prepare(
      `SELECT r.*, i.customer, i.amount FROM invoice_reminders r JOIN invoices i ON i.id = r.invoice_id
       WHERE r.status IN ('draft','approved') ORDER BY r.created_at DESC`
    )
    .all();
  res.json({
    summary: getReceivablesSummary(),
    invoices,
    reminders,
    workflow: getWorkflowState(),
    live: integrationConnected('servicetrade') || integrationConnected('stripe'),
  });
});

/** Draft a reminder (gated — creates a draft awaiting approval). */
router.post('/api/invoices/:id/draft-reminder', async (req, res) => {
  try {
    const r = await draftInvoiceReminder(Number(req.params.id));
    res.json({ ok: true, reminder: r });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Approve a drafted reminder (still does not SEND unless a messaging integration is live). */
router.post('/api/invoices/reminders/:id/approve', (req, res) => {
  const db = getDb();
  const sendable = integrationConnected('gmail') || integrationConnected('sms');
  const status = sendable ? 'sent' : 'approved';
  db.prepare(`UPDATE invoice_reminders SET status = ? WHERE id = ?`).run(status, Number(req.params.id));
  res.json({ ok: true, status, sent: sendable });
});

/** Mark an invoice paid (manual reconcile until QuickBooks/Stripe are wired). */
router.post('/api/invoices/:id/mark-paid', (req, res) => {
  const id = Number(req.params.id);
  getDb().prepare(`UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).run(id);
  completeWorkflowIfPaid(id); // stop chasing a paid invoice
  res.json({ ok: true });
});

/* ─────────────── Collection Workflow (daily dunning until paid) ─────────────── */

/** Enroll an invoice into the daily email+text workflow (the human gate). */
router.post('/api/invoices/:id/enroll', (req, res) => {
  try {
    const channels = Array.isArray(req.body?.channels) ? (req.body.channels as Channel[]) : undefined;
    const wf = enrollInvoice(Number(req.params.id), channels);
    res.json({ ok: true, workflow: wf });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** Pause / resume / stop a workflow. */
router.post('/api/invoices/workflow/:id/:action(pause|resume|stop)', (req, res) => {
  const map = { pause: 'paused', resume: 'active', stop: 'stopped' } as const;
  setWorkflowStatus(Number(req.params.id), map[req.params.action as keyof typeof map]);
  res.json({ ok: true });
});

/** Run today's cycle now (demo trigger; the cron runs this daily). */
router.post('/api/invoices/workflow/run', async (_req, res) => {
  const result = await runDailyCollection({ force: true });
  res.json({ ok: true, result });
});

export default router;
