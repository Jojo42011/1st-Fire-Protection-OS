import { Router } from 'express';
import { getDb } from '../db/index';

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

router.get('/api/approvals', (_req, res) => {
  const items = openItems();
  res.json({ items, counts: counts(items), live: false });
});

/** Approve one item. Idempotent — a second call on an already-decided row just returns it. */
router.post('/api/approvals/:id/approve', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as ApprovalRow | undefined;
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });

  if (row.status === 'pending') {
    db.prepare(`UPDATE approvals SET status = 'approved', decided_by = 'Devon', decided_at = datetime('now') WHERE id = ?`).run(id);
    db.prepare(`INSERT INTO approval_events (approval_id, action, detail) VALUES (?, 'approved', ?)`).run(id, row.kind);
    // In the shell, "executing" only logs — nothing leaves the building until keys exist.
    db.prepare(`INSERT INTO approval_events (approval_id, action, detail) VALUES (?, 'executed', ?)`).run(
      id,
      `${row.kind} (simulated: no provider key)`
    );
  }
  const item = db.prepare(`${SELECT} WHERE id = ?`).get(id) as ApprovalRow;
  res.json({ ok: true, item });
});

/** Edit the draft body of a pending item (the copy that gets sent once keys exist).
 *  Leaves it pending — the human still has to approve the edited version. */
router.post('/api/approvals/:id/edit', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : null;
  if (!body) return res.status(400).json({ ok: false, error: 'body required' });

  const row = db.prepare(`SELECT status FROM approvals WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  if (row.status !== 'pending') return res.status(409).json({ ok: false, error: `already ${row.status}` });

  db.prepare(`UPDATE approvals SET body = ? WHERE id = ?`).run(body, id);
  db.prepare(`INSERT INTO approval_events (approval_id, action, detail) VALUES (?, 'edited', ?)`).run(id, 'body edited by human');
  const item = db.prepare(`${SELECT} WHERE id = ?`).get(id) as ApprovalRow;
  res.json({ ok: true, item });
});

/** Skip (dismiss) one item. Idempotent. */
router.post('/api/approvals/:id/skip', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT status FROM approvals WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  if (row.status === 'pending') {
    db.prepare(`UPDATE approvals SET status = 'skipped', decided_by = 'Devon', decided_at = datetime('now') WHERE id = ?`).run(id);
    db.prepare(`INSERT INTO approval_events (approval_id, action) VALUES (?, 'skipped')`).run(id);
  }
  res.json({ ok: true });
});

/** Approve every pending routine item at once. Returns the ids that were approved. */
router.post('/api/approvals/approve-routine', (_req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT id, kind FROM approvals WHERE status = 'pending' AND risk = 'routine'`).all() as Array<{
    id: number;
    kind: string;
  }>;
  const approve = db.prepare(
    `UPDATE approvals SET status = 'approved', decided_by = 'Devon', decided_at = datetime('now') WHERE id = ? AND status = 'pending'`
  );
  const logDecide = db.prepare(`INSERT INTO approval_events (approval_id, action, detail) VALUES (?, 'approved', ?)`);
  const logExec = db.prepare(`INSERT INTO approval_events (approval_id, action, detail) VALUES (?, 'executed', ?)`);
  const tx = db.transaction((list: Array<{ id: number; kind: string }>) => {
    for (const r of list) {
      approve.run(r.id);
      logDecide.run(r.id, r.kind);
      logExec.run(r.id, `${r.kind} (simulated: no provider key)`);
    }
  });
  tx(rows);
  res.json({ ok: true, approved: rows.map((r) => r.id) });
});

export default router;
