import crypto from 'crypto';
import { getDb } from '../db/index';
import { getQuote } from './quotesBuilder';
import { sendProposal } from './proposalEmail';
import { createApproval } from '../routes/approvals';
import { osAudit } from '../os/audit';

/**
 * The external-action outbox: every externally consequential action (today: proposal email) is queued
 * here, tied to an approval, and executed server-side exactly once.
 *
 * Guarantees:
 *  - Draft-first / approval-controlled: queueing creates an approval; nothing sends on a browser click.
 *  - Revision-aware: the approval binds to a hash of the exact quote snapshot + recipient. Editing the
 *    quote changes the hash, supersedes the prior action, and the old approval can no longer execute.
 *  - Idempotent: idempotency_key = kind:subject:revision:recipient is UNIQUE, and execution re-checks
 *    status inside a transaction, so a retry / refresh / double-click / worker restart never sends twice.
 *  - Safe metadata: only provider status + a short truncated detail are stored, never tokens or bodies.
 */

export type ActionStatus = 'pending_approval' | 'approved' | 'sending' | 'sent' | 'failed' | 'superseded';

export interface ExternalAction {
  id: number; kind: string; subject_type: string | null; subject_id: number | null; office: string | null;
  recipient: string | null; subject: string | null; revision_hash: string | null; idempotency_key: string | null;
  status: ActionStatus; approval_id: number | null; actor: string | null; provider_status: string | null;
  provider_detail: string | null; attempts: number; created_at: string; updated_at: string; sent_at: string | null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A deterministic hash of the send-relevant quote snapshot + recipient. Any content edit changes it. */
export function proposalRevisionHash(quoteId: number, recipient: string): string | null {
  const d = getQuote(quoteId);
  if (!d) return null;
  const q = d.quote;
  const snap = {
    number: q.number, customer: q.customer, contact: q.contact, title: q.title, type: q.type,
    sell: d.totals.sellPrice, mat: d.totals.matCost, hrs: d.totals.laborHrs,
    scope: q.scope, inclusions: q.inclusions, exclusions: q.exclusions,
    system_type: q.system_type, hazard: q.hazard, sf: q.sf,
    lines: d.lines.map((l) => ({ n: l.name, q: l.qty, c: l.cost, h: l.hrs, s: l.sku })),
    to: recipient.trim().toLowerCase(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex').slice(0, 24);
}

export function getAction(id: number): ExternalAction | null {
  return (getDb().prepare(`SELECT * FROM external_actions WHERE id = ?`).get(id) as ExternalAction) || null;
}
export function actionForApproval(approvalId: number): ExternalAction | null {
  return (getDb().prepare(`SELECT * FROM external_actions WHERE approval_id = ? ORDER BY id DESC LIMIT 1`).get(approvalId) as ExternalAction) || null;
}

/**
 * Queue a proposal email for approval. Returns the pending action + approval, or a terminal result if
 * this exact revision was already sent. Supersedes any earlier pending action for the same quote whose
 * revision differs (an edit invalidates the old approval).
 */
export function queueProposalSend(input: { quoteId: number; recipient: string; actor: string; office: string | null; belowFloor?: boolean; floor?: number; markup?: number }):
  { ok: true; already?: boolean; actionId: number; approvalId: number | null; revision: string } | { ok: false; error: string } {
  const recipient = String(input.recipient || '').trim();
  if (!EMAIL_RE.test(recipient)) return { ok: false, error: 'invalid_email' };
  const d = getQuote(input.quoteId);
  if (!d) return { ok: false, error: 'not_found' };
  const revision = proposalRevisionHash(input.quoteId, recipient);
  if (!revision) return { ok: false, error: 'not_found' };
  const key = `proposal_email:${input.quoteId}:${revision}:${recipient.toLowerCase()}`;
  const db = getDb();

  return db.transaction(() => {
    // Already sent for this exact revision + recipient: idempotent no-op.
    const sent = db.prepare(`SELECT * FROM external_actions WHERE idempotency_key = ? AND status = 'sent'`).get(key) as ExternalAction | undefined;
    if (sent) return { ok: true as const, already: true, actionId: sent.id, approvalId: sent.approval_id, revision };

    // Supersede any earlier still-open action for this quote at a different revision (edits invalidate).
    db.prepare(`UPDATE external_actions SET status = 'superseded', updated_at = datetime('now')
                WHERE subject_type = 'est_quote' AND subject_id = ? AND status IN ('pending_approval','approved') AND idempotency_key != ?`)
      .run(input.quoteId, key);

    // Reuse a pending row for this exact revision, else create one.
    let row = db.prepare(`SELECT * FROM external_actions WHERE idempotency_key = ?`).get(key) as ExternalAction | undefined;
    const subject = `Proposal ${d.quote.number} · ${d.branding.llc}`;
    if (!row) {
      const info = db.prepare(
        `INSERT INTO external_actions (kind, subject_type, subject_id, office, recipient, subject, revision_hash, idempotency_key, status, actor)
         VALUES ('proposal_email','est_quote', ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`
      ).run(input.quoteId, input.office || d.quote.office, recipient, subject, revision, key, input.actor);
      row = getAction(Number(info.lastInsertRowid))!;
    } else if (row.status !== 'pending_approval') {
      db.prepare(`UPDATE external_actions SET status = 'pending_approval', updated_at = datetime('now') WHERE id = ?`).run(row.id);
    }

    const money = '$' + Math.round(d.totals.sellPrice).toLocaleString('en-US');
    const floorNote = input.belowFloor ? `\nBELOW MARGIN FLOOR: effective markup ${input.markup}% < ${input.floor}% floor.` : '';
    const approvalId = createApproval({
      agent_key: 'estimator', kind: 'send_email',
      risk: input.belowFloor || d.totals.sellPrice >= 25000 ? 'sensitive' : 'routine',
      title: `Send proposal ${d.quote.number} to ${recipient}`,
      stake: money,
      body: `Email the ${money} proposal for ${d.quote.customer || 'the customer'} to ${recipient}.${floorNote}`,
      trail: `Revision ${revision}. Approving sends the proposal via Microsoft 365.`,
      subject_type: 'est_quote', subject_id: input.quoteId,
    });
    db.prepare(`UPDATE external_actions SET approval_id = ?, updated_at = datetime('now') WHERE id = ?`).run(approvalId, row.id);
    return { ok: true as const, actionId: row.id, approvalId, revision };
  })();
}

/**
 * Execute a queued action exactly once. Re-verifies the revision (an edit after approval refuses), then
 * sends via Microsoft 365 and records safe provider metadata. Idempotent: a second call returns the
 * recorded result without re-sending.
 */
export async function executeAction(actionId: number, actor: string): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  const db = getDb();
  // Claim the action for sending inside a transaction so concurrent callers can't both proceed.
  const claim = db.transaction(() => {
    const a = getAction(actionId);
    if (!a) return { proceed: false as const, result: { ok: false, error: 'not_found' } };
    if (a.status === 'sent') return { proceed: false as const, result: { ok: true, already: true } };
    if (a.status === 'superseded') return { proceed: false as const, result: { ok: false, error: 'superseded' } };
    if (a.status === 'sending') return { proceed: false as const, result: { ok: false, error: 'in_progress' } };
    db.prepare(`UPDATE external_actions SET status = 'sending', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?`).run(actionId);
    return { proceed: true as const, action: a };
  })();
  if (!claim.proceed) return claim.result;
  const a = claim.action;

  // Revision guard: if the quote changed since approval, refuse and supersede.
  const currentRev = a.subject_id != null ? proposalRevisionHash(a.subject_id, a.recipient || '') : null;
  if (!currentRev || currentRev !== a.revision_hash) {
    db.prepare(`UPDATE external_actions SET status = 'superseded', provider_detail = 'revision changed before send', updated_at = datetime('now') WHERE id = ?`).run(actionId);
    osAudit({ actor, office: a.office, module: 'deficiencies', action: 'proposal.send_refused', subject_type: 'est_quote', subject_id: a.subject_id, detail: 'quote revision changed after approval' });
    return { ok: false, error: 'revision_changed' };
  }

  let out: { ok: boolean; error?: string };
  try {
    out = await sendProposal(a.subject_id as number, a.recipient as string);
  } catch (e) {
    out = { ok: false, error: (e as Error).message };
  }
  const safeDetail = (out.error || 'sent').replace(/[A-Za-z0-9._-]{40,}/g, '[redacted]').slice(0, 180);
  if (out.ok) {
    db.prepare(`UPDATE external_actions SET status = 'sent', provider_status = 'accepted', provider_detail = 'Microsoft 365 accepted', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(actionId);
    osAudit({ actor, office: a.office, module: 'deficiencies', action: 'proposal.send', subject_type: 'est_quote', subject_id: a.subject_id, new_summary: `sent to ${a.recipient}`, detail: `revision ${a.revision_hash}` });
    return { ok: true };
  }
  db.prepare(`UPDATE external_actions SET status = 'failed', provider_status = 'error', provider_detail = ?, updated_at = datetime('now') WHERE id = ?`).run(safeDetail, actionId);
  osAudit({ actor, office: a.office, module: 'deficiencies', action: 'proposal.send_failed', subject_type: 'est_quote', subject_id: a.subject_id, detail: safeDetail });
  return { ok: false, error: out.error };
}

/** Execute the action tied to an approved approval (called by the approvals approve route). */
export async function executeForApproval(approvalId: number, actor: string): Promise<{ ok: boolean; already?: boolean; error?: string } | null> {
  const a = actionForApproval(approvalId);
  if (!a) return null;
  return executeAction(a.id, actor);
}

/** When a quote is edited, supersede any open (unsent) proposal actions so a stale approval can't send. */
export function invalidateQuoteActions(quoteId: number): number {
  return getDb().prepare(
    `UPDATE external_actions SET status = 'superseded', updated_at = datetime('now')
     WHERE subject_type = 'est_quote' AND subject_id = ? AND status IN ('pending_approval','approved')`
  ).run(quoteId).changes;
}

/** Count of failed external actions (for the readiness screen). */
export function failedActionCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) c FROM external_actions WHERE status = 'failed'`).get() as { c: number }).c;
}
