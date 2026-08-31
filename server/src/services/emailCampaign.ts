import { getDb } from '../db/index';
import { graphToken } from './licenseSources';

/**
 * Server-side bulk email (e.g. the customer remittance notice). Sends one individual message per
 * recipient from a shared mailbox using the app's existing application Mail.Send permission, so there
 * is no local script, no client secret on a workstation, and no delegated send-as problem.
 *
 * A campaign is stored with its recipient list; each recipient carries a status (pending/sent/failed).
 * send-batch processes a bounded number per call (kept well under the request timeout) and paces the
 * sends, so the whole run is driven by repeated calls and is fully resumable: only pending recipients
 * are ever sent, so a re-run never double-sends.
 */

let ensured = false;
function ensureTables(): void {
  if (ensured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      from_addr    TEXT NOT NULL,
      subject      TEXT NOT NULL,
      body_html    TEXT NOT NULL,
      save_to_sent INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS email_recipients (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      email       TEXT NOT NULL,
      name        TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|failed
      error       TEXT,
      sent_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_recipients_campaign ON email_recipients(campaign_id, status);
  `);
  // Optional inline logo (content-ID attachment), added after the fact so existing tables upgrade.
  for (const col of ['logo_b64 TEXT', 'logo_cid TEXT', 'logo_name TEXT', 'logo_ctype TEXT']) {
    try { db.exec(`ALTER TABLE email_campaigns ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  ensured = true;
}

/** Update a campaign's subject/body and optionally set an inline logo (content-ID attachment). */
export function updateCampaignContent(id: number, opts: {
  subject?: string; bodyHtml?: string;
  logoBase64?: string; logoContentId?: string; logoName?: string; logoContentType?: string;
}): { ok: boolean; error?: string } {
  ensureTables();
  const db = getDb();
  const c = db.prepare(`SELECT id FROM email_campaigns WHERE id = ?`).get(id);
  if (!c) return { ok: false, error: 'campaign not found' };
  if (opts.subject !== undefined) db.prepare(`UPDATE email_campaigns SET subject = ? WHERE id = ?`).run(String(opts.subject), id);
  if (opts.bodyHtml !== undefined) db.prepare(`UPDATE email_campaigns SET body_html = ? WHERE id = ?`).run(String(opts.bodyHtml), id);
  if (opts.logoBase64 !== undefined) {
    db.prepare(`UPDATE email_campaigns SET logo_b64 = ?, logo_cid = ?, logo_name = ?, logo_ctype = ? WHERE id = ?`)
      .run(opts.logoBase64 || null, opts.logoContentId || 'companylogo', opts.logoName || 'logo.png', opts.logoContentType || 'image/png', id);
  }
  return { ok: true };
}

export interface CampaignStatus {
  ok: boolean; error?: string;
  id: number; from: string; subject: string;
  total: number; pending: number; sent: number; failed: number; done: boolean;
}

/** Create a campaign and load its recipients (deduped by email). Returns the campaign id + count. */
export function createCampaign(opts: {
  from: string; subject: string; bodyHtml: string; saveToSent?: boolean;
  recipients: { email: string; name?: string }[];
}): { ok: boolean; error?: string; id?: number; count?: number } {
  ensureTables();
  const from = String(opts.from || '').trim();
  const subject = String(opts.subject || '').trim();
  const body = String(opts.bodyHtml || '');
  if (!from || !subject || !body) return { ok: false, error: 'from, subject, and bodyHtml are required' };
  const seen = new Set<string>();
  const clean = (opts.recipients || [])
    .map((r) => ({ email: String(r.email || '').trim(), name: (r.name || '').trim() }))
    .filter((r) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email))
    .filter((r) => { const k = r.email.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!clean.length) return { ok: false, error: 'no valid recipients' };
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO email_campaigns (from_addr, subject, body_html, save_to_sent) VALUES (?,?,?,?)`
  ).run(from, subject, body, opts.saveToSent === false ? 0 : 1);
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare(`INSERT INTO email_recipients (campaign_id, email, name) VALUES (?,?,?)`);
  const tx = db.transaction((rows: typeof clean) => { for (const r of rows) ins.run(id, r.email, r.name || null); });
  tx(clean);
  return { ok: true, id, count: clean.length };
}

interface Logo { b64: string; cid: string; name: string; ctype: string }

async function graphSendMail(token: string, from: string, to: string, subject: string, bodyHtml: string, saveToSent: boolean, logo?: Logo | null): Promise<{ ok: boolean; error?: string }> {
  const message: any = {
    subject,
    body: { contentType: 'HTML', content: bodyHtml },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  if (logo && logo.b64) {
    message.attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: logo.name, contentType: logo.ctype, isInline: true, contentId: logo.cid, contentBytes: logo.b64,
    }];
  }
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: saveToSent }),
  });
  if (res.status === 202 || res.ok) return { ok: true };
  return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
}

function logoOf(c: any): Logo | null {
  return c && c.logo_b64 ? { b64: c.logo_b64, cid: c.logo_cid || 'companylogo', name: c.logo_name || 'logo.png', ctype: c.logo_ctype || 'image/png' } : null;
}

export function getCampaignStatus(id: number): CampaignStatus {
  ensureTables();
  const db = getDb();
  const c = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(id) as any;
  if (!c) return { ok: false, error: 'campaign not found', id, from: '', subject: '', total: 0, pending: 0, sent: 0, failed: 0, done: true };
  const counts = db.prepare(
    `SELECT status, COUNT(*) AS c FROM email_recipients WHERE campaign_id = ? GROUP BY status`
  ).all(id) as { status: string; c: number }[];
  const by: Record<string, number> = {};
  for (const r of counts) by[r.status] = r.c;
  const total = (by.pending || 0) + (by.sent || 0) + (by.failed || 0);
  return {
    ok: true, id, from: c.from_addr, subject: c.subject,
    total, pending: by.pending || 0, sent: by.sent || 0, failed: by.failed || 0,
    done: (by.pending || 0) === 0,
  };
}

/** Send one message to an explicit address (a test), using the campaign's from/subject/body. */
export async function sendTest(id: number, to: string): Promise<{ ok: boolean; error?: string }> {
  ensureTables();
  const db = getDb();
  const c = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(id) as any;
  if (!c) return { ok: false, error: 'campaign not found' };
  const token = await graphToken();
  if (!token) return { ok: false, error: 'Microsoft Graph is not connected' };
  return graphSendMail(token, c.from_addr, String(to).trim(), c.subject, c.body_html, !!c.save_to_sent, logoOf(c));
}

export interface BatchResult { ok: boolean; error?: string; batchSent: number; batchFailed: number; status: CampaignStatus; }

/**
 * Send up to `max` pending recipients, pacing `delayMs` between each. Keep max*delay comfortably under
 * the request timeout (e.g. 12 x 4000ms = 48s). Re-run until status.done. Optionally requeue failed
 * first so a re-run retries them.
 */
export async function sendBatch(id: number, max = 12, delayMs = 4000, retryFailed = false): Promise<BatchResult> {
  ensureTables();
  const db = getDb();
  const c = db.prepare(`SELECT * FROM email_campaigns WHERE id = ?`).get(id) as any;
  if (!c) return { ok: false, error: 'campaign not found', batchSent: 0, batchFailed: 0, status: getCampaignStatus(id) };
  const token = await graphToken();
  if (!token) return { ok: false, error: 'Microsoft Graph is not connected', batchSent: 0, batchFailed: 0, status: getCampaignStatus(id) };
  if (retryFailed) db.prepare(`UPDATE email_recipients SET status='pending', error=NULL WHERE campaign_id=? AND status='failed'`).run(id);

  const rows = db.prepare(
    `SELECT id, email FROM email_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT ?`
  ).all(id, Math.max(1, Math.min(50, max))) as { id: number; email: string }[];

  const markSent = db.prepare(`UPDATE email_recipients SET status='sent', sent_at=datetime('now'), error=NULL WHERE id=?`);
  const markFail = db.prepare(`UPDATE email_recipients SET status='failed', error=? WHERE id=?`);
  const logo = logoOf(c);
  let batchSent = 0, batchFailed = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // eslint-disable-next-line no-await-in-loop
    const out = await graphSendMail(token, c.from_addr, r.email, c.subject, c.body_html, !!c.save_to_sent, logo);
    if (out.ok) { markSent.run(r.id); batchSent++; }
    else { markFail.run(out.error || 'send failed', r.id); batchFailed++; }
    // eslint-disable-next-line no-await-in-loop
    if (i < rows.length - 1 && delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
  }
  return { ok: true, batchSent, batchFailed, status: getCampaignStatus(id) };
}

/** The failed recipients (email + error) for a campaign, for review. */
export function listFailures(id: number): { email: string; error: string }[] {
  ensureTables();
  return getDb().prepare(
    `SELECT email, COALESCE(error,'') AS error FROM email_recipients WHERE campaign_id=? AND status='failed' ORDER BY email`
  ).all(id) as { email: string; error: string }[];
}
