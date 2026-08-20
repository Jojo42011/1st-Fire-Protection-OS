/**
 * Intake links: tokenised, single-use onboarding invites.
 *
 * A hiring manager needs no OS account. A People user creates a link (a random token with a 7-day
 * expiry), the manager opens it and fills the 5-step intake form, and submitting generates a real
 * onboarding request through the existing onboardingAgent. A token is dead the moment it is
 * submitted (single-use), voided (a resend supersedes it), or expired. Nothing is emailed on its
 * own: creating a link returns the URL to share, and a nudge only records that a reminder was due.
 */
import crypto from 'crypto';
import { getDb } from '../db/index';
import { createRequest, OnboardingPayload, OWNERS } from './onboardingAgent';

const OWNER_TAG: Record<string, string> = OWNERS.reduce((m, o) => ((m[o.key] = o.tag), m), {} as Record<string, string>);

const LINK_TTL_DAYS = 7;

export interface IntakeLink {
  id: number;
  token: string;
  job_title: string | null;
  office: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  status: 'sent' | 'opened' | 'submitted' | 'voided' | 'expired';
  created_by: string | null;
  sent_at: string | null;
  opened_at: string | null;
  submitted_at: string | null;
  nudged_at: string | null;
  voided_at: string | null;
  expires_at: string;
  request_id: number | null;
}

function newToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

/** The honest lifecycle: submitted/voided are terminal; otherwise expiry wins over opened/sent. */
function liveStatus(row: IntakeLink): IntakeLink['status'] {
  if (row.status === 'submitted' || row.status === 'voided') return row.status;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  return row.opened_at ? 'opened' : 'sent';
}

/** A row shaped for the client: status recomputed, token never leaked into list views. */
function present(row: IntakeLink) {
  const status = liveStatus(row);
  return {
    id: row.id,
    job_title: row.job_title,
    office: row.office,
    recipient_name: row.recipient_name,
    recipient_email: row.recipient_email,
    status,
    sent_at: row.sent_at,
    opened_at: row.opened_at,
    submitted_at: row.submitted_at,
    nudged_at: row.nudged_at,
    expires_at: row.expires_at,
    request_id: row.request_id,
    hasSubmission: !!row.request_id,
  };
}

export function createIntakeLink(input: {
  job_title?: string;
  office?: string;
  recipient_name?: string;
  recipient_email?: string;
  created_by?: string;
}): { link: ReturnType<typeof present>; token: string } {
  const db = getDb();
  const token = newToken();
  const expires = new Date(Date.now() + LINK_TTL_DAYS * 86400000).toISOString();
  const info = db
    .prepare(
      `INSERT INTO intake_links (token, job_title, office, recipient_name, recipient_email, status, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)`
    )
    .run(
      token,
      input.job_title || null,
      input.office || null,
      input.recipient_name || null,
      input.recipient_email || null,
      input.created_by || 'system',
      expires
    );
  const row = db.prepare(`SELECT * FROM intake_links WHERE id = ?`).get(Number(info.lastInsertRowid)) as IntakeLink;
  return { link: present(row), token };
}

export function listIntakeLinks(base?: string) {
  const rows = getDb().prepare(`SELECT * FROM intake_links ORDER BY id DESC`).all() as IntakeLink[];
  return rows.map((r) => {
    const p = present(r);
    // The shareable URL is only useful while the link can still be opened; the token rides in the URL.
    const usable = p.status === 'sent' || p.status === 'opened';
    return { ...p, url: usable ? `${base || ''}/intake/${r.token}` : null };
  });
}

/** Resolve a token for the public form. Returns null when it cannot be used (with a reason). */
export function resolveToken(token: string): { ok: true; link: IntakeLink } | { ok: false; reason: string } {
  const row = getDb().prepare(`SELECT * FROM intake_links WHERE token = ?`).get(token) as IntakeLink | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  const status = liveStatus(row);
  if (status === 'submitted') return { ok: false, reason: 'already_submitted' };
  if (status === 'voided') return { ok: false, reason: 'voided' };
  if (status === 'expired') return { ok: false, reason: 'expired' };
  return { ok: true, link: row };
}

/** Mark a token opened the first time the form loads it. Idempotent. */
export function markOpened(token: string): void {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM intake_links WHERE token = ?`).get(token) as IntakeLink | undefined;
  if (!row || row.opened_at || row.status === 'submitted' || row.status === 'voided') return;
  db.prepare(`UPDATE intake_links SET opened_at = datetime('now'), status = 'opened' WHERE token = ? AND opened_at IS NULL`).run(token);
}

/** Map the intake form's values onto an onboarding request payload. */
function toPayload(vals: any): OnboardingPayload {
  const laptop = String(vals.laptop || '');
  const computer_type = /none/i.test(laptop) ? 'none' : /estimat|32gb|cad/i.test(laptop) ? 'business' : 'standard';
  const notes = [
    vals.equipNotes && `Equipment: ${vals.equipNotes}`,
    vals.accessNotes && `Access: ${vals.accessNotes}`,
    vals.building && vals.building !== 'Standard hours' && `Building access: ${vals.building}`,
    vals.mvr && vals.mvr !== 'Yes' && 'MVR consent still outstanding',
    vals.license && `Licence: ${vals.license}`,
    Array.isArray(vals.certs) && vals.certs.length ? `Certs: ${vals.certs.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
  return {
    name: String(vals.legal || vals.preferred || '').trim(),
    personal_email: vals.email || undefined,
    start_date: vals.start || undefined,
    cell_phone: vals.mobile || undefined,
    job_position: vals.title || undefined,
    manager_name: vals.manager || undefined,
    computer_type,
    company_cell: String(vals.phone || '') === 'Yes',
    company_vehicle: /truck/i.test(String(vals.vehicle || '')),
    wex_card: String(vals.vehicle || '') === 'Assigned truck',
    software: Array.isArray(vals.systems) ? vals.systems : [],
    misc_exceptions: notes || undefined,
  };
}

/** Submit a token: single-use. Creates the onboarding request and closes the link. */
export function submitIntake(token: string, vals: any): { ok: true; request_id: number; teams: string[] } | { ok: false; reason: string } {
  const db = getDb();
  const check = resolveToken(token);
  if (!check.ok) return { ok: false, reason: check.reason };
  const payload = toPayload(vals || {});
  if (!payload.name) return { ok: false, reason: 'name_required' };
  const out = createRequest(payload);
  const requestId = out.request?.id ?? null;
  db.prepare(
    `UPDATE intake_links SET status = 'submitted', submitted_at = datetime('now'), submission_json = ?, request_id = ? WHERE token = ?`
  ).run(JSON.stringify(vals || {}), requestId, token);
  // Clean team names (the owner's tag), deduped, dropping the ledger-builder pseudo-owner.
  const teams = Array.from(
    new Set((out.items || []).map((i: any) => OWNER_TAG[i.owner] || i.owner).filter((t: string) => t && t !== 'BambooHR'))
  );
  return { ok: true, request_id: requestId as number, teams };
}

/** Resend: void the old token and issue a fresh one for the same recipient/role/office. */
export function resendIntakeLink(id: number, actor: string): { link: ReturnType<typeof present>; token: string } | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM intake_links WHERE id = ?`).get(id) as IntakeLink | undefined;
  if (!row) return null;
  if (row.status !== 'submitted') {
    db.prepare(`UPDATE intake_links SET status = 'voided', voided_at = datetime('now') WHERE id = ?`).run(id);
  }
  return createIntakeLink({
    job_title: row.job_title || undefined,
    office: row.office || undefined,
    recipient_name: row.recipient_name || undefined,
    recipient_email: row.recipient_email || undefined,
    created_by: actor,
  });
}

/** Discard: void an outstanding link so it can no longer be opened or submitted. A link that was
 * already submitted is terminal and cannot be discarded; the call reports that instead. */
export function voidIntakeLink(id: number): { ok: true } | { ok: false; reason: string } {
  const db = getDb();
  const row = db.prepare(`SELECT status FROM intake_links WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'submitted') return { ok: false, reason: 'already_submitted' };
  if (row.status === 'voided') return { ok: true }; // idempotent
  db.prepare(`UPDATE intake_links SET status = 'voided', voided_at = datetime('now') WHERE id = ?`).run(id);
  return { ok: true };
}

/** Record that a reminder was due (no email backend yet, so this only timestamps the nudge). */
export function nudgeIntakeLink(id: number): boolean {
  const info = getDb()
    .prepare(`UPDATE intake_links SET nudged_at = datetime('now') WHERE id = ? AND status IN ('sent','opened')`)
    .run(id);
  return info.changes > 0;
}

/** The submitted values for one link (for "View submission"). */
export function getSubmission(id: number): any | null {
  const row = getDb().prepare(`SELECT submission_json FROM intake_links WHERE id = ?`).get(id) as { submission_json: string | null } | undefined;
  if (!row || !row.submission_json) return null;
  try {
    return JSON.parse(row.submission_json);
  } catch {
    return null;
  }
}
