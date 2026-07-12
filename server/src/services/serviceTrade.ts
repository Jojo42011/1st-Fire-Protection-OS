import { getDb } from '../db/index';
import { scheduleReminders } from './reminderWorkflow';
import { serviceTradeEnabled } from '../config/comms';

/**
 * ServiceTrade (field service system of record) → Invoice Collector bridge.
 *
 * Two ingest paths, one normalizer (mirrors the receptionist's Vapi pattern):
 *  - push: ServiceTrade posts an event to /api/webhooks/servicetrade in real time.
 *  - pull: syncFromServiceTrade() backfills open invoices via the REST API.
 * Both feed normalizeInvoice() → upsertInvoice() (keyed on servicetrade_id) and, when the
 * invoice is tied to a completed job, arm the day-1/3/5/7 reminder sequence.
 *
 * Graceful degradation: keyless boot still ingests webhook payloads (demo-friendly); the
 * REST pull no-ops without SERVICETRADE_TOKEN.
 */

export interface StInvoiceFields {
  servicetrade_id: string;
  servicetrade_job_id?: string;
  customer: string;
  email?: string;
  phone?: string;
  amount: number;
  issued_at?: string;
  due_at?: string;
  job_completed_at?: string;
}

function firstStr(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

function toDate(v: unknown): string | undefined {
  if (typeof v === 'number' && v > 0) return new Date(v * 1000).toISOString().slice(0, 10); // ST uses unix seconds
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return undefined;
}

/**
 * Normalize a ServiceTrade invoice object (from a webhook `data`/`invoice` node or a REST
 * `/invoice` record) into our flat fields. Reads defensively across field locations so it
 * survives ServiceTrade shape differences.
 */
export function normalizeInvoice(src: any): StInvoiceFields | null {
  const inv = src?.invoice || src?.data?.invoice || src?.data || src || {};
  const id = firstStr(inv.id ? String(inv.id) : undefined, inv.number, inv.invoiceId);
  if (!id) return null;

  const job = inv.job || inv.serviceRequest || src?.job || {};
  const customerNode = inv.customer || inv.company || job.customer || {};
  const contact = inv.contact || customerNode.primaryContact || {};

  const amount =
    typeof inv.totalPrice === 'number'
      ? inv.totalPrice
      : typeof inv.total === 'number'
      ? inv.total
      : typeof inv.amount === 'number'
      ? inv.amount
      : Number(inv.balanceDue || inv.amountDue || 0) || 0;

  return {
    servicetrade_id: id,
    servicetrade_job_id: firstStr(job.id ? String(job.id) : undefined, inv.jobId ? String(inv.jobId) : undefined),
    customer: firstStr(customerNode.name, inv.customerName, job.name) || 'ServiceTrade customer',
    email: firstStr(contact.email, customerNode.email, inv.email),
    phone: firstStr(contact.phone, customerNode.phone, inv.phone),
    amount,
    issued_at: toDate(inv.transactionDate ?? inv.createdDate ?? inv.issuedDate ?? inv.created),
    due_at: toDate(inv.dueDate ?? inv.due),
    job_completed_at: toDate(job.completedOn ?? job.completed ?? inv.completedOn ?? src?.completedOn),
  };
}

/** Insert or update an invoice keyed on servicetrade_id. Returns the row id + whether new. */
export function upsertInvoice(f: StInvoiceFields): { id: number; inserted: boolean } {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM invoices WHERE servicetrade_id = ?').get(f.servicetrade_id) as
    | { id: number }
    | undefined;

  if (existing) {
    db.prepare(
      `UPDATE invoices SET customer=?, email=COALESCE(?,email), phone=COALESCE(?,phone), amount=?,
         issued_at=COALESCE(?,issued_at), due_at=COALESCE(?,due_at),
         job_completed_at=COALESCE(?,job_completed_at), servicetrade_job_id=COALESCE(?,servicetrade_job_id)
       WHERE id=?`
    ).run(
      f.customer,
      f.email || null,
      f.phone || null,
      f.amount,
      f.issued_at || null,
      f.due_at || null,
      f.job_completed_at || null,
      f.servicetrade_job_id || null,
      existing.id
    );
    return { id: existing.id, inserted: false };
  }

  const info = db
    .prepare(
      `INSERT INTO invoices (customer, email, phone, amount, issued_at, due_at, status,
         servicetrade_id, servicetrade_job_id, job_completed_at, auto_remind)
       VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, 1)`
    )
    .run(
      f.customer,
      f.email || null,
      f.phone || null,
      f.amount,
      f.issued_at || null,
      f.due_at || null,
      f.servicetrade_id,
      f.servicetrade_job_id || null,
      f.job_completed_at || null
    );
  return { id: Number(info.lastInsertRowid), inserted: true };
}

/**
 * Ingest one ServiceTrade event (webhook body or REST invoice). Upserts the invoice and,
 * once a completion date is known, arms the reminder sequence. Idempotent: re-delivery
 * updates the same row and never double-schedules (unique index guards the steps).
 */
export function ingestServiceTradeInvoice(raw: any): {
  invoiceId: number | null;
  inserted: boolean;
  scheduled: number;
  live: boolean;
} {
  const fields = normalizeInvoice(raw);
  if (!fields) return { invoiceId: null, inserted: false, scheduled: 0, live: serviceTradeEnabled() };

  const { id, inserted } = upsertInvoice(fields);

  // Arm reminders only once we know when the job was completed (the cadence anchor).
  let scheduled = 0;
  if (fields.job_completed_at) {
    scheduled = scheduleReminders(id).scheduled;
  }
  return { invoiceId: id, inserted, scheduled, live: serviceTradeEnabled() };
}

/**
 * Pull open invoices from ServiceTrade and backfill them. Graceful no-op without a token.
 * Complements the webhook so the dashboard stays current even if a delivery is missed.
 */
export async function syncFromServiceTrade(): Promise<{ synced: number; live: boolean; error?: string }> {
  const token = process.env.SERVICETRADE_TOKEN;
  if (!token) return { synced: 0, live: false };
  try {
    const base = process.env.SERVICETRADE_API_BASE || 'https://api.servicetrade.com/api';
    const res = await fetch(`${base}/invoice?status=unpaid&limit=200`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    if (!res.ok) return { synced: 0, live: true, error: `servicetrade ${res.status}: ${await res.text()}` };
    const data = (await res.json()) as any;
    const list: any[] = data?.data?.invoices || data?.invoices || (Array.isArray(data) ? data : []);
    let synced = 0;
    for (const raw of list) {
      const r = ingestServiceTradeInvoice(raw);
      if (r.invoiceId) synced++;
    }
    return { synced, live: true };
  } catch (err) {
    return { synced: 0, live: true, error: (err as Error).message };
  }
}
