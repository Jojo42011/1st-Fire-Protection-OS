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
  employee_id: number | null;
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

/** The confirmed BambooHR hire a link is bound to (name, role, office, start), or null when freehand. */
export function boundHire(row: { employee_id: number | null }): { id: number; name: string; job_position: string | null; office: string | null; start_date: string | null; manager: string | null; work_email: string | null } | null {
  if (!row.employee_id) return null;
  const e = getDb().prepare(
    `SELECT id, legal_first_name, legal_last_name, preferred_name, entra_display_name, job_position, public_job_title, office, manager, work_email, anticipated_start_date, actual_start_date
       FROM employees WHERE id = ?`
  ).get(row.employee_id) as any;
  if (!e) return null;
  const name = e.entra_display_name || `${e.legal_first_name || ''} ${e.legal_last_name || ''}`.trim() || e.preferred_name || `Employee ${e.id}`;
  return { id: e.id, name, job_position: e.job_position || e.public_job_title || null, office: e.office || null, start_date: e.actual_start_date || e.anticipated_start_date || null, manager: e.manager || null, work_email: e.work_email || null };
}

/** A row shaped for the client: status recomputed, token never leaked into list views. */
function present(row: IntakeLink) {
  const status = liveStatus(row);
  const hire = boundHire(row);
  return {
    id: row.id,
    employee_id: row.employee_id,
    hire,
    job_title: row.job_title || (hire ? hire.job_position : null),
    office: row.office || (hire ? hire.office : null),
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

/** Warn (do not block) when a hire already has onboarding in flight: a submitted request, or another
 *  open link. Returns a human sentence for the admin, or null when this is the first one. */
export function duplicateOnboardingWarning(employeeId: number | null | undefined, excludeLinkId?: number): string | null {
  if (!employeeId) return null;
  const db = getDb();
  const req = db.prepare(`SELECT created_at FROM onboarding_requests WHERE employee_id = ? ORDER BY id DESC LIMIT 1`).get(employeeId) as { created_at: string } | undefined;
  if (req) {
    const when = req.created_at ? String(req.created_at).slice(0, 10) : 'earlier';
    return `This hire already has a submitted onboarding request (${when}). Creating another will duplicate the provisioning tasks: void one if this was not intended.`;
  }
  const links = db.prepare(`SELECT * FROM intake_links WHERE employee_id = ?`).all(employeeId) as IntakeLink[];
  const open = links.filter((l) => l.id !== excludeLinkId && (liveStatus(l) === 'sent' || liveStatus(l) === 'opened'));
  if (open.length) return `There is already an open intake link for this hire that has not been submitted yet. You now have ${open.length + 1}; void the extras to avoid duplicate requests.`;
  return null;
}

export function createIntakeLink(input: {
  employee_id?: number;
  job_title?: string;
  office?: string;
  recipient_name?: string;
  recipient_email?: string;
  created_by?: string;
}): { link: ReturnType<typeof present>; token: string } {
  const db = getDb();
  const token = newToken();
  const expires = new Date(Date.now() + LINK_TTL_DAYS * 86400000).toISOString();
  // When bound to a confirmed hire, snapshot their role/office from the employee record so the link
  // and its list row read correctly even before the manager opens the form.
  const hire = input.employee_id ? boundHire({ employee_id: input.employee_id }) : null;
  const info = db
    .prepare(
      `INSERT INTO intake_links (token, employee_id, job_title, office, recipient_name, recipient_email, status, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?)`
    )
    .run(
      token,
      input.employee_id || null,
      input.job_title || (hire ? hire.job_position : null),
      input.office || (hire ? hire.office : null),
      input.recipient_name || (hire ? hire.manager : null),
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

/** Everything the invite email needs for one link: the shareable URL (only while usable), the
 *  recipient, and the bound hire. Null when the link does not exist. */
export function linkForEmail(id: number, base: string): { url: string; recipient_name: string | null; recipient_email: string | null; hire: ReturnType<typeof boundHire>; job_title: string | null; office: string | null; status: IntakeLink['status'] } | null {
  const row = getDb().prepare(`SELECT * FROM intake_links WHERE id = ?`).get(id) as IntakeLink | undefined;
  if (!row) return null;
  const status = liveStatus(row);
  const usable = status === 'sent' || status === 'opened';
  const hire = boundHire(row);
  return { url: usable ? `${base}/intake/${row.token}` : '', recipient_name: row.recipient_name, recipient_email: row.recipient_email, hire, job_title: row.job_title || (hire ? hire.job_position : null), office: row.office || (hire ? hire.office : null), status };
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

/** Map the intake form's values onto an onboarding request payload. The manager intake now captures
 *  the same operational fields as the internal full form, so this is a straight pass-through: the
 *  account and safety-gear multi-selects fan out to their booleans, everything else maps by name. No
 *  pay, SSN, or bank details are ever collected here. */
function toPayload(vals: any): OnboardingPayload {
  const arr = (x: unknown): string[] => (Array.isArray(x) ? (x as string[]) : []);
  const accounts = arr(vals.accounts);
  const gear = arr(vals.safety_gear);
  return {
    name: String(vals.legal || vals.preferred || '').trim(),
    personal_email: vals.email || undefined,
    start_date: vals.start || undefined,
    cell_phone: vals.mobile || undefined,
    job_position: vals.title || undefined,
    manager_name: vals.manager || undefined,
    company_email: accounts.includes('Company email'),
    teams_number: accounts.includes('Teams number'),
    computer_type: vals.computer_type && vals.computer_type !== 'none' ? String(vals.computer_type) : 'none',
    dock: !!vals.dock,
    software: arr(vals.software),
    sharepoint: arr(vals.sharepoint),
    printers: arr(vals.printers),
    company_cell: gear.includes('Company cell phone'),
    ipad: gear.includes('Company iPad'),
    vehicle_transfer: gear.includes('Company vehicle transfer'),
    wex_card: gear.includes('WEX fuel card'),
    company_vehicle: !!vals.company_vehicle,
    vehicle_details: vals.vehicle_details || undefined,
  };
}

/** Submit a token: single-use. Creates the onboarding request and closes the link. */
export function submitIntake(token: string, vals: any): { ok: true; request_id: number; teams: string[] } | { ok: false; reason: string } {
  const db = getDb();
  const check = resolveToken(token);
  if (!check.ok) return { ok: false, reason: check.reason };
  const payload = toPayload(vals || {});
  // Bound to a confirmed hire: the person's identity comes from BambooHR, not from the manager. Only
  // the operational fields (equipment/access) are taken from the form, and the request attaches to
  // the real employee instead of creating a duplicate.
  const hire = boundHire(check.link);
  if (hire) {
    payload.employee_id = hire.id;
    payload.name = hire.name;
    payload.job_position = hire.job_position || payload.job_position;
    payload.manager_name = hire.manager || payload.manager_name;
    payload.start_date = hire.start_date || payload.start_date;
  }
  if (!payload.name) return { ok: false, reason: 'name_required' };
  let out: ReturnType<typeof createRequest>;
  try {
    out = createRequest(payload);
  } catch {
    // The link stays open so the manager can retry; nothing is marked submitted on a failed create.
    return { ok: false, reason: 'create_failed' };
  }
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
    employee_id: row.employee_id || undefined,
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
