import { getDb } from '../db/index';
import { chat } from './llm';
import { COMPANY } from '../config/constants';

/**
 * Invoice Collector engine — a reminder-sequence strategist. Given an overdue invoice,
 * drafts the right-tempered message. NOTHING sends without approval (gated action).
 */

export interface Invoice {
  id: number;
  customer: string;
  email: string | null;
  phone: string | null;
  amount: number;
  issued_at: string | null;
  due_at: string | null;
  status: string;
  last_reminder_at: string | null;
  paid_at: string | null;
  notes: string | null;
}

export function daysOverdue(inv: Invoice): number {
  if (!inv.due_at || inv.status === 'paid') return 0;
  const due = new Date(inv.due_at + 'T00:00:00Z').getTime();
  return Math.max(0, Math.floor((Date.now() - due) / 86400000));
}

function tierFor(days: number): { tier: string; tone: string } {
  if (days >= 30) return { tier: 'final', tone: 'a firm final notice — professional, not hostile' };
  if (days >= 14) return { tier: 'firm', tone: 'a firmer follow-up — clear and direct' };
  return { tier: 'friendly', tone: 'a friendly nudge — warm and low-pressure' };
}

/** Deterministic fallback when no LLM key is present. */
function templateReminder(inv: Invoice, tier: string): string {
  const amt = `$${inv.amount.toFixed(2)}`;
  const opener =
    tier === 'final'
      ? `This is a final notice regarding invoice #${inv.id}.`
      : tier === 'firm'
        ? `Following up on invoice #${inv.id}, which is now past due.`
        : `Just a friendly reminder about invoice #${inv.id}.`;
  return [
    `Hi ${inv.customer},`,
    '',
    `${opener} The balance of ${amt} was due on ${inv.due_at || 'the agreed date'}.`,
    tier === 'final'
      ? `Please arrange payment within 5 business days so we can keep your account in good standing. If you have already paid, disregard this note.`
      : `Whenever you get a chance, we'd appreciate settling the balance. If there's any question about the work, just reply and we'll sort it out.`,
    '',
    `Thank you for trusting ${COMPANY.name} with your fire protection & life safety.`,
    `${COMPANY.name} · ${COMPANY.phone}`,
  ].join('\n');
}

/** Draft a reminder for an invoice and persist it as status='draft' (awaiting approval). */
export async function draftInvoiceReminder(invoiceId: number): Promise<{ id: number; body: string; tier: string }> {
  const db = getDb();
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as Invoice | undefined;
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);

  const days = daysOverdue(inv);
  const { tier, tone } = tierFor(days);

  let body = templateReminder(inv, tier);
  const result = await chat(
    [
      {
        role: 'system',
        content: `You draft payment-reminder messages for ${COMPANY.name}, a fire protection & life safety company in Texas. Brand voice: ${COMPANY.brandVoice}. Write ${tone}. Keep it under 120 words, sign off as the company, never threaten. Never use an em dash (—); use a comma, a colon, or two sentences instead. Output ONLY the message body.`,
      },
      {
        role: 'user',
        content: `Customer: ${inv.customer}\nInvoice #${inv.id}\nAmount: $${inv.amount.toFixed(2)}\nDue: ${inv.due_at}\nDays overdue: ${days}\nNotes: ${inv.notes || 'none'}`,
      },
    ],
    { fast: true, maxTokens: 400 }
  );
  if (result && result.text) body = result.text;

  const info = db
    .prepare(`INSERT INTO invoice_reminders (invoice_id, tier, body, status) VALUES (?, ?, ?, 'draft')`)
    .run(invoiceId, tier, body);
  db.prepare(`UPDATE invoices SET status = 'reminded', last_reminder_at = datetime('now') WHERE id = ? AND status != 'paid'`).run(
    invoiceId
  );
  return { id: Number(info.lastInsertRowid), body, tier };
}

export interface ReceivablesSummary {
  totalOutstanding: number;
  count: number;
  buckets: { '0-30': number; '31-60': number; '61-90': number; '90+': number };
  collectedThisMonth: number;
}

export function getReceivablesSummary(): ReceivablesSummary {
  const db = getDb();
  const invoices = db.prepare(`SELECT * FROM invoices WHERE status != 'paid'`).all() as Invoice[];
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  let total = 0;
  for (const inv of invoices) {
    total += inv.amount;
    const d = daysOverdue(inv);
    if (d <= 30) buckets['0-30'] += inv.amount;
    else if (d <= 60) buckets['31-60'] += inv.amount;
    else if (d <= 90) buckets['61-90'] += inv.amount;
    else buckets['90+'] += inv.amount;
  }
  const collected = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) AS s FROM invoices WHERE status = 'paid' AND paid_at >= date('now','start of month')`
    )
    .get() as { s: number };
  return {
    totalOutstanding: total,
    count: invoices.length,
    buckets,
    collectedThisMonth: collected.s,
  };
}
