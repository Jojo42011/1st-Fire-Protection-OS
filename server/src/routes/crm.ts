import { Router } from 'express';
import { getDb } from '../db/index';
import { hasRealAccounts } from '../services/servicetradeSync';

/**
 * CRM (Signal Phase 4) — Accounts, Account detail and Pipeline. Shell only: everything
 * serves the seeded fixtures and reports live:false. Stage changes queue a push through
 * sync_queue (never inline) and return optimistically.
 */
const router = Router();

const money = (cents: number): string =>
  '$' + Math.round((cents || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
const initials = (name: string): string =>
  name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
const fmtDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
};
const ago = (iso: string | null): string => {
  if (!iso) return '';
  const mins = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return Math.round(mins) + 'm ago';
  if (mins < 1440) return Math.round(mins / 60) + 'h ago';
  return Math.round(mins / 1440) + 'd ago';
};

const CONTRACT = (t: string | null) => (t === 'contract' ? 'Contract' : t === 'tm' ? 'T&M' : t === 'prospect' ? 'Prospect' : t || '');
const TOUCH = (k: string | null) =>
  ({ call: 'Call', autopilot: 'Autopilot', quote: 'Quote', job: 'Job done', review: 'Review', booked: 'Booked', invoice: 'Invoice' } as Record<string, string>)[
    k || ''
  ] || (k || '');

// Segment → monogram tint, matching the design.
const SEG_TINT: Record<string, [string, string]> = {
  Medical: ['var(--money-bg)', 'var(--money)'],
  Education: ['var(--amber-bg)', 'var(--amber-ink)'],
  Retail: ['var(--fill)', 'var(--ink-2)'],
  Industrial: ['var(--indigo-bg-2)', 'var(--indigo)'],
  Storage: ['var(--fill)', 'var(--ink-2)'],
  Government: ['var(--indigo-bg-2)', 'var(--indigo)'],
  Hospitality: ['var(--green-bg)', 'var(--green)'],
};

interface Acc {
  id: number; st_id: string; name: string; segment: string; contract_type: string;
  contract_renews_at: string | null; owner_user: string; customer_since: string;
  balance_cents: number; lifetime_cents: number; avg_days_to_pay: number | null;
  risk: string | null; last_touch_at: string | null; last_touch_kind: string | null;
}

router.get('/api/accounts', (req, res) => {
  const db = getDb();
  const filter = String(req.query.filter || 'all');
  const limit = Math.min(Number(req.query.limit) || 8, 50);

  // Once real ServiceTrade customers have been pulled, the screen shows ONLY those (live);
  // until then it serves the keyless demo seed (fixtures).
  const real = hasRealAccounts();
  const all = (real
    ? db.prepare(`SELECT * FROM accounts WHERE source = 'servicetrade' ORDER BY name ASC`).all()
    : db.prepare(`SELECT * FROM accounts ORDER BY id ASC`).all()) as Acc[];
  const counts = real
    ? {
        all: all.length,
        contract: all.filter((a) => a.contract_type === 'contract').length,
        due: all.filter((a) => a.balance_cents > 0).length,
        risk: all.filter((a) => a.risk === 'at_risk').length,
      }
    : {
        all: 412,
        contract: 118,
        due: 34,
        risk: all.filter((a) => a.risk === 'at_risk').length || 9,
      };

  let list = all;
  if (filter === 'contract') list = all.filter((a) => a.contract_type === 'contract');
  else if (filter === 'risk') list = all.filter((a) => a.risk === 'at_risk');
  const sliced = list.slice(0, limit);

  const accounts = sliced.map((a) => {
    const sites = (db.prepare(`SELECT COUNT(*) AS v FROM sites WHERE account_id = ?`).get(a.id) as { v: number }).v;
    const nextSite = db
      .prepare(`SELECT next_service_at FROM sites WHERE account_id = ? AND next_service_at IS NOT NULL ORDER BY next_service_at ASC LIMIT 1`)
      .get(a.id) as { next_service_at: string } | undefined;
    const next = nextSite
      ? 'Inspection due ' + fmtDate(nextSite.next_service_at)
      : a.contract_type === 'prospect'
      ? 'Quote to send'
      : a.risk === 'at_risk'
      ? 'Follow-up due'
      : 'Scheduled';
    const tint = SEG_TINT[a.segment] || ['var(--fill)', 'var(--ink-2)'];
    return {
      id: a.id,
      initials: initials(a.name),
      name: a.name,
      segment: `${a.segment} · since ${a.customer_since}`,
      tintBg: tint[0],
      tintFg: tint[1],
      sites: sites ? `${sites} site${sites === 1 ? '' : 's'}` : '—',
      contract: CONTRACT(a.contract_type),
      contractKind: a.contract_type === 'prospect' ? 'indigo' : a.contract_type === 'tm' ? 'gray' : 'green',
      next,
      balance: money(a.balance_cents),
      balanceOverdue: a.balance_cents > 0 && a.risk === 'at_risk',
      touch: a.last_touch_kind === 'autopilot' ? 'Autopilot · today' : `${TOUCH(a.last_touch_kind)} · ${ago(a.last_touch_at)}`,
    };
  });

  res.json({ accounts, counts, total: real ? all.length : 412, showing: accounts.length, live: real });
});

router.get('/api/accounts/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const a = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as Acc | undefined;
  if (!a) return res.status(404).json({ ok: false, error: 'not found' });

  const sites = (db.prepare(`SELECT * FROM sites WHERE account_id = ? ORDER BY id`).all(id) as any[]).map((s) => {
    const eq = db.prepare(`SELECT kind, count FROM equipment WHERE site_id = ? ORDER BY id`).all(s.id) as Array<{ kind: string; count: number }>;
    return { ...s, equipment: eq, next_label: fmtDate(s.next_service_at) };
  });
  const contacts = db.prepare(`SELECT * FROM contacts WHERE account_id = ? ORDER BY is_primary DESC, id`).all(id);
  const events = db
    .prepare(
      `SELECT tag, title, body, source, meta,
              CAST((julianday('now') - julianday(occurred_at)) * 24 * 60 AS INTEGER) AS age_mins
         FROM account_events WHERE account_id = ? ORDER BY occurred_at DESC`
    )
    .all(id);

  const quotedNotWon = (
    db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS v FROM quotes WHERE account_id = ? AND stage IN ('quoted','following_up')`).get(id) as {
      v: number;
    }
  ).v;

  const stats = {
    lifetime: money(a.lifetime_cents),
    balance: money(a.balance_cents),
    avgDaysToPay: a.avg_days_to_pay ?? '—',
    openDeficiencies: 6,
    quotedNotWon: money(quotedNotWon),
    reviews: '4.9 ★',
  };

  res.json({
    account: {
      ...a,
      initials: initials(a.name),
      contract: CONTRACT(a.contract_type),
      renews: fmtDate(a.contract_renews_at),
      overdueDays: a.risk === 'at_risk' && a.balance_cents > 0 ? 98 : 0,
      meta: `${a.segment} · ${sites.length} site${sites.length === 1 ? '' : 's'} · customer since ${a.customer_since} · ServiceTrade ID ${(a.st_id || '').replace('ST-', '')} · owner ${a.owner_user}`,
    },
    sites,
    contacts,
    stats,
    events,
    live: false,
  });
});

// Pipeline — per-stage headline count/total are fixtures (matching the design); the deal
// cards are the seeded quotes.
const STAGES = [
  { key: 'lead', label: 'Lead', sq: 'var(--muted)', count: 6, total: 5400000 },
  { key: 'quoted', label: 'Quoted', sq: 'var(--indigo)', count: 14, total: 18600000 },
  { key: 'following_up', label: 'Following up', sq: 'var(--amber)', count: 9, total: 12100000 },
  { key: 'won', label: 'Won', sq: 'var(--green)', count: 7, total: 5100000 },
  { key: 'lost', label: 'Lost', sq: 'var(--border-strong)', count: 3, total: 2200000 },
];

function dealChip(q: any): { text: string; tone: string } {
  if (q.stage === 'lost') return { text: 'reason logged', tone: 'gray' };
  if (q.stage === 'won') return { text: 'synced', tone: 'green' };
  if (q.stage === 'following_up') return q.snooze_until ? { text: 'snoozed', tone: 'gray' } : { text: 'agent working', tone: 'indigo' };
  if (q.stage === 'quoted') {
    if (q.opened_count >= 3) return { text: `opened ${q.opened_count}×`, tone: 'indigo' };
    if (!q.opened_count) return { text: 'no reply', tone: 'money' };
    return { text: 'day 1', tone: 'gray' };
  }
  return q.origin === 'call' ? { text: 'from a call', tone: 'green' } : { text: q.origin || 'lead', tone: 'gray' };
}

router.get('/api/pipeline', (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT q.*, a.name AS customer FROM quotes q LEFT JOIN accounts a ON a.id = q.account_id ORDER BY q.amount_cents DESC`
    )
    .all() as any[];

  const stages = STAGES.map((s) => {
    const deals = rows
      .filter((q) => q.stage === s.key)
      .map((q) => {
        const chip = dealChip(q);
        return {
          id: q.id,
          customer: q.customer || 'Prospect',
          detail: q.title,
          amount: money(q.amount_cents),
          chip: chip.text,
          chipTone: chip.tone,
          lost: s.key === 'lost',
        };
      });
    return { key: s.key, label: s.label, sq: s.sq, count: s.count, total: money(s.total), deals };
  });

  res.json({
    stats: { open: '$412,300', aging: 11, winRate: '38%', fromDeficiencies: '$96,400' },
    stages,
    live: false,
  });
});

router.post('/api/pipeline/:quoteId/stage', (req, res) => {
  const db = getDb();
  const id = Number(req.params.quoteId);
  const stage = String(req.body?.stage || '');
  const valid = ['lead', 'quoted', 'following_up', 'won', 'lost'];
  if (!valid.includes(stage)) return res.status(400).json({ ok: false, error: 'invalid stage' });

  const q = db.prepare(`SELECT st_id FROM quotes WHERE id = ?`).get(id) as { st_id: string } | undefined;
  if (!q) return res.status(404).json({ ok: false, error: 'not found' });

  db.prepare(`UPDATE quotes SET stage = ?, sync_state = 'pending_push', local_updated_at = datetime('now') WHERE id = ?`).run(stage, id);
  // Queue the push — never write to ServiceTrade inline.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO sync_queue (object, local_id, st_id, op, payload, idempotency_key)
       VALUES ('quotes', ?, ?, 'update', ?, ?)`
    ).run(id, q.st_id || null, JSON.stringify({ stage }), `quote-${id}-stage-${stage}`);
    db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('out', ?, 'queued', 'quotes')`).run(
      `Quote stage → ${stage.replace('_', ' ')}`
    );
  } catch {
    /* queue is best-effort in the shell */
  }
  res.json({ ok: true, stage, live: false });
});

export default router;
