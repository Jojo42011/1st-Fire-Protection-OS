import { Router } from 'express';
import { getDb } from '../db/index';
import { draftInvoiceReminder, getReceivablesSummary, daysOverdue, Invoice } from '../services/invoiceAgent';
import { integrationConnected } from '../config/integrations';

const router = Router();

/** Dashboard data: summary + invoice list + reminder queue. */
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
  getDb()
    .prepare(`UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?`)
    .run(Number(req.params.id));
  res.json({ ok: true });
});

export default router;
