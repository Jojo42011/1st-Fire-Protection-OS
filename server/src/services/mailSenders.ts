/**
 * Per-purpose outbound mail senders. Different flows send AS different mailboxes (onboarding invites
 * from onboarding@, review requests from reviews@, AP notices from accountspayable@, ...). Each
 * purpose has a row here; a blank address falls back to the MS_MAIL_FROM default so nothing breaks
 * before the specific mailboxes exist. The app's Mail.Send permission lets it send as any mailbox in
 * the tenant (subject to any application access policy), so this is just address configuration.
 */
import { getDb } from '../db/index';
import { mailCredsPresent } from './msGraphMail';

export interface MailSender { key: string; label: string; address: string; display_name: string; configured: boolean }

// The purposes the OS knows about today. New flows add a key here (and seed it) then call senderFor.
const PURPOSES: { key: string; label: string; display_name: string; defaultFromEnv?: boolean }[] = [
  { key: 'onboarding', label: 'Onboarding invites', display_name: '1st Fire Protection', defaultFromEnv: true },
  { key: 'reviews', label: 'Review requests', display_name: '1st Fire Protection' },
  { key: 'ap', label: 'Accounts payable', display_name: '1st FP Accounts Payable' },
  { key: 'reports', label: 'Scheduled reports', display_name: '1st Fire Protection', defaultFromEnv: true },
  { key: 'notifications', label: 'General notifications', display_name: '1st Fire Protection', defaultFromEnv: true },
];

export function seedMailSenders(): void {
  const db = getDb();
  const envFrom = process.env.MS_MAIL_FROM || '';
  const ins = db.prepare(`INSERT OR IGNORE INTO mail_senders (key, label, address, display_name) VALUES (?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const p of PURPOSES) ins.run(p.key, p.label, p.defaultFromEnv ? envFrom : '', p.display_name);
  });
  tx();
}

function rowFor(key: string): { key: string; label: string; address: string; display_name: string } | undefined {
  return getDb().prepare(`SELECT key, label, address, display_name FROM mail_senders WHERE key = ?`).get(key) as any;
}

/** Resolve the mailbox a purpose sends from: its configured address, else the MS_MAIL_FROM default. */
export function senderFor(key: string): { address: string; name: string } | null {
  const row = rowFor(key);
  const address = (row && row.address) || process.env.MS_MAIL_FROM || '';
  if (!address) return null;
  return { address, name: (row && row.display_name) || '1st Fire Protection' };
}

export function listMailSenders(): MailSender[] {
  const envFrom = process.env.MS_MAIL_FROM || '';
  try {
    const rows = getDb().prepare(`SELECT key, label, address, display_name FROM mail_senders ORDER BY rowid`).all() as any[];
    return rows.map((r) => {
      const address = r.address || envFrom;
      return { key: r.key, label: r.label || r.key, address, display_name: r.display_name || '1st Fire Protection', configured: mailCredsPresent() && !!address };
    });
  } catch {
    return [];
  }
}

export function setMailSender(key: string, input: { address?: string; display_name?: string }, actor: string): MailSender | null {
  const db = getDb();
  const row = rowFor(key);
  if (!row) return null;
  const address = input.address !== undefined ? String(input.address).trim() : row.address;
  const display = input.display_name !== undefined ? String(input.display_name).trim() : row.display_name;
  db.prepare(`UPDATE mail_senders SET address = ?, display_name = ?, updated_by = ?, updated_at = datetime('now') WHERE key = ?`).run(address, display, actor, key);
  return listMailSenders().find((s) => s.key === key) || null;
}
