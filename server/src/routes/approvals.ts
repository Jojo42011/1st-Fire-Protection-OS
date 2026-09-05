import { Router } from 'express';
import { getDb } from '../db/index';
import { requireOs, actorOf } from '../os/authz';
import { P } from '../os/policy';
import { osAudit } from '../os/audit';
import { executeForApproval } from '../services/outbox';

/**
 * The approvals inbox (Signal Phase 3) — one queue for every gated action across all
 * agents. Reads from the `approvals` table (the single source of truth for the inbox and
 * the "needs your yes" badge). Approving is idempotent and, in this shell, "executing" an
 * action only logs an approval_events row — nothing sends until the provider keys exist.
 */
const router = Router();

interface ApprovalRow {
  id: number;
  agent_key: string;
  kind: string;
  risk: string;
  title: string;
  stake: string | null;
  body: string | null;
  trail: string | null;
  subject_type: string | null;
  subject_id: number | null;
  status: string;
  age_mins: number;
  created_at: string;
}

/**
 * Dual-write helper: the agents keep their own status columns AND drop an approval row
 * here so the unified inbox is the one source of truth. Deduped on (subject_type,
 * subject_id, kind) among open rows — re-drafting refreshes the existing row instead of
 * piling up duplicates. Safe to call best-effort; callers wrap it so a failure never
 * breaks the underlying draft. */
export function createApproval(a: {
  agent_key: string;
  kind: string;
  risk: string;
  title: string;
  stake?: string;
  body?: string;
  trail?: string;
  subject_type?: string;
  subject_id?: number;
}): number {
  const db = getDb();
  if (a.subject_type && a.subject_id != null) {
    const existing = db
      .prepare(`SELECT id FROM approvals WHERE status = 'pending' AND subject_type = ? AND subject_id = ? AND kind = ?`)
      .get(a.subject_type, a.subject_id, a.kind) as { id: number } | undefined;
    if (existing) {
      db.prepare(`UPDATE approvals SET title = ?, stake = ?, body = ?, trail = ? WHERE id = ?`).run(
        a.title,
        a.stake ?? null,
        a.body ?? null,
        a.trail ?? null,
        existing.id
      );
      return existing.id;
    }
  }
  const info = db
    .prepare(
      `INSERT INTO approvals (agent_key, kind, risk, title, stake, body, trail, subject_type, subject_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(a.agent_key, a.kind, a.risk, a.title, a.stake ?? null, a.body ?? null, a.trail ?? null, a.subject_type ?? null, a.subject_id ?? null);
  return Number(info.lastInsertRowid);
}

const SELECT =
  `SELECT id, agent_key, kind, risk, title, stake, body, trail, subject_type, subject_id, status,
          created_at,
          CAST((julianday('now') - julianday(created_at)) * 24 * 60 AS INTEGER) AS age_mins
     FROM approvals`;

// Which filter chip each kind belongs to (design: Sends something / Spends money / Posts publicly).
const SEND_KINDS = new Set(['send_email', 'send_sms']);
const MONEY_KINDS = new Set(['cancel_seat', 'quote_price']);
const PUBLISH_KINDS = new Set(['publish', 'push_st']);
const SCHEDULE_KINDS = new Set(['schedule_change']);

function openItems(): ApprovalRow[] {
  return getDb()
    .prepare(`${SELECT} WHERE status = 'pending' ORDER BY created_at DESC`)
    .all() as ApprovalRow[];
}

function counts(items: ApprovalRow[]) {
  return {
    all: items.length,
    send: items.filter((i) => SEND_KINDS.has(i.kind)).length,
    money: items.filter((i) => MONEY_KINDS.has(i.kind)).length,
    publish: items.filter((i) => PUBLISH_KINDS.has(i.kind)).length,
    schedule: items.filter((i) => SCHEDULE_KINDS.has(i.kind)).length,
  };
}

router.get('/api/approvals', requireOs(P.approvals_read), (_req, res) => {
  const items = openItems();
  res.json({ items, counts: counts(items), live: false });
});

/**
 * Approve one item. Requires a mapped identity (real actor stamped, never a hardcoded name). If the
 * item is tied to an external action (e.g. a proposal email), approving executes it server-side, once,
 * idempotently, with a fresh revision check. A second call on an already-decided row just returns it.
 */
router.post('/api/approvals/:id/approve', requireOs(P.approvals_decide), async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const who = actorOf(req);
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as ApprovalRow | undefined;
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });

  let execution: { ok: boolean; already?: boolean; error?: string } | null = null;
  if (row.status === 'pending') {
    db.prepare(`UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = datetime('now') WHERE id = ?`).run(who.label, id);
    db.prepare(`INSERT INTO approval_events (approval_id, action, detail) VALUES (?, 'approved', ?)`).run(id, `${row.kind} by ${who.label}`);
    osAudit({ actor: who.label, actor_email: who.email, module: 'overview', action: 'approval.approve', subject_type: row.subject_type, subject_id: row.subject_id, detail: row.kind });
    execution = await executeForApproval(id, who.label);
    const detail = execution ? (execution.ok ? (execution.already ? 'already sent (idempotent)' : 'sent') : `failed: ${execution.error || 'error'}`) : 'no external action';
    db.prepare(`INSERT INTO approval_events (approval_id, action, detail) VALUES (?, 'executed', ?)`).run(id, detail);
  }
  const item = db.prepare(`${SELECT} WHERE id = ?`).get(id) as ApprovalRow;
  res.json({ ok: true, item, execution });
});

/** Edit the human-facing note on a pending item. Leaves it pending; the send content is bound to the
 *  quote revision in the outbox, so editing this note never changes what actually gets sent. */
router.post('/api/approvals/:id/edit', requireOs(P.approvals_decide), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : null;
  if (!body) return res.status(400).json({ ok: false, error: 'body required' });

  const row = db.prepare(`SELECT status FROM approvals WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  if (row.status !== 'pending') return res.status(409).json({ ok: false, error: `already ${row.status}` });

  db.prepare(`UPDATE approvals SET body = ? WHERE id = ?`).run(body, id);
  db.prepare(`INSERT INTO approval_events (approval_id, action, detail) VALUES (?, 'edited', ?)`).run(id, `note edited by ${actorOf(req).label}`);
  const item = db.prepare(`${SELECT} WHERE id = ?`).get(id) as ApprovalRow;
  res.json({ ok: true, item });
});

/** Skip (dismiss) one item. Idempotent. */
router.post('/api/approvals/:id/skip', requireOs(P.approvals_decide), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const who = actorOf(req);
  const row = db.prepare(`SELECT status FROM approvals WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  if (row.status === 'pending') {
    db.prepare(`UPDATE approvals SET status = 'skipped', decided_by = ?, decided_at = datetime('now') WHERE id = ?`).run(who.label, id);
    db.prepare(`INSERT INTO approval_events (approval_id, action) VALUES (?, 'skipped')`).run(id);
    osAudit({ actor: who.label, actor_email: who.email, module: 'overview', action: 'approval.skip', subject_id: id });
  }
  res.json({ ok: true });
});

/** Approve every pending ROUTINE item at once, executing any linked external actions idempotently. */
router.post('/api/approvals/approve-routine', requireOs(P.approvals_decide), async (req, res) => {
  const db = getDb();
  const who = actorOf(req);
  const rows = db.prepare(`SELECT id, kind FROM approvals WHERE status = 'pending' AND risk = 'routine'`).all() as Array<{ id: number; kind: string }>;
  const approve = db.prepare(`UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'`);
  const logDecide = db.prepare(`INSERT INTO approval_events (approval_id, action, detail) VALUES (?, 'approved', ?)`);
  const logExec = db.prepare(`INSERT INTO approval_events (approval_id, action, detail) VALUES (?, 'executed', ?)`);
  for (const r of rows) {
    approve.run(who.label, r.id);
    logDecide.run(r.id, `${r.kind} by ${who.label}`);
    const execution = await executeForApproval(r.id, who.label);
    logExec.run(r.id, execution ? (execution.ok ? (execution.already ? 'already sent' : 'sent') : `failed: ${execution.error || 'error'}`) : 'no external action');
  }
  osAudit({ actor: who.label, actor_email: who.email, module: 'overview', action: 'approval.approve_routine', new_summary: `${rows.length} items` });
  res.json({ ok: true, approved: rows.map((r) => r.id) });
});

export default router;
