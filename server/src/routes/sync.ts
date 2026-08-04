import { Router } from 'express';
import { getDb } from '../db/index';

/**
 * ServiceTrade sync (Signal Phase 4) — SHELL ONLY. ServiceTrade is never called: the
 * direction map, conflict queue and log all serve seeded fixtures and report live:false.
 * "Sync now" just appends a log row. Outbound writes would drain sync_queue later; nothing
 * writes to ServiceTrade without passing the approval rules.
 */
const router = Router();

// direction → the mono chip the design shows
const DIR = (d: string): { text: string; tone: string } =>
  d === 'both'
    ? { text: '↔ both ways', tone: 'indigo' }
    : d === 'in'
    ? { text: '← from ST', tone: 'gray' }
    : d === 'out'
    ? { text: '→ to ST', tone: 'green' }
    : { text: 'off', tone: 'gray' };

// per-object counts, live from the mirror where we have a table (accounts/sites/jobs/quotes);
// '—' for objects not row-mirrored (equipment/contacts not pulled; invoices roll into balances).
function liveCounts(): Record<string, string> {
  const db = getDb();
  const c = (t: string) => {
    try { return ((db.prepare(`SELECT COUNT(*) AS v FROM ${t} WHERE source = 'servicetrade'`).get() as { v: number }).v || 0).toLocaleString('en-US'); }
    catch { return '—'; }
  };
  const acc = c('accounts');
  return acc === '0' || acc === '—'
    ? { accounts: '412 / 908', equipment: '14,220', jobs: '1,904 open', quotes: '39 open', invoices: '23 open', contacts: '1,166', agent_output: '96 today' }
    : { accounts: `${acc} / ${c('sites')}`, equipment: '—', jobs: `${c('crm_jobs')} open`, quotes: c('quotes'), invoices: '— (in balances)', contacts: '—', agent_output: '—' };
}

const ago = (iso: string | null): string => {
  if (!iso) return '';
  const mins = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return Math.round(mins) + 'm ago';
  if (mins < 1440) return Math.round(mins / 60) + 'h ago';
  return Math.round(mins / 1440) + 'd ago';
};
const clock = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return `${h}:${m}${ap}`;
};
const FIELD_LABEL: Record<string, string> = { billing_email: 'billing email', stage: 'quote stage' };

router.get('/api/sync', (_req, res) => {
  const db = getDb();

  const COUNT = liveCounts();
  const objects = (db.prepare(`SELECT * FROM sync_objects ORDER BY rowid`).all() as any[]).map((o) => {
    const dir = DIR(o.direction);
    return { object: o.object, label: o.label, detail: o.detail, direction: o.direction, dir: dir.text, dirTone: dir.tone, count: COUNT[o.object] || String(o.record_count) };
  });
  const n = (t: string) => { try { return (db.prepare(`SELECT COUNT(*) AS v FROM ${t} WHERE source = 'servicetrade'`).get() as { v: number }).v || 0; } catch { return 0; } };
  const real = n('accounts') > 0;
  const mirrored = n('accounts') + n('sites') + n('crm_jobs') + n('quotes');

  const conflicts = (db.prepare(`SELECT * FROM sync_conflicts WHERE status = 'open' ORDER BY id`).all() as any[]).map((c) => {
    const acc = db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(c.local_id) as { name: string } | undefined;
    return {
      id: c.id,
      title: `${acc ? acc.name : c.object} — ${FIELD_LABEL[c.field] || c.field}`,
      field: c.field,
      theirValue: c.their_value,
      theirWhen: c.their_updated_at ? ago(c.their_updated_at) : '',
      ourValue: c.our_value,
      ourWhen: c.our_updated_at ? ago(c.our_updated_at) : '',
      ourOrigin: c.our_origin,
      mono: /@|\./.test(c.their_value || '') && !/ /.test(c.their_value || ''),
    };
  });

  const log = (db.prepare(`SELECT * FROM sync_log ORDER BY at DESC LIMIT 12`).all() as any[]).map((l) => {
    const dir = l.direction === 'both' ? { text: '↔ both', tone: 'indigo' } : l.direction === 'in' ? { text: '← in', tone: 'gray' } : { text: '→ out', tone: 'green' };
    return { time: clock(l.at), dir: dir.text, dirTone: dir.tone, text: l.text, state: l.state };
  });

  res.json({
    connected: real,
    mode: 'two-way',
    volumes: real
      ? `${n('accounts').toLocaleString('en-US')} customers, ${n('sites').toLocaleString('en-US')} sites, ${n('crm_jobs').toLocaleString('en-US')} jobs, ${n('quotes').toLocaleString('en-US')} quotes`
      : '412 customers, 908 sites, 14,220 pieces of equipment',
    counters: real
      ? { pulled: mirrored.toLocaleString('en-US'), pushed: '0', conflicts: conflicts.length }
      : { pulled: '1,482', pushed: '96', conflicts: conflicts.length },
    objects,
    conflicts,
    log,
    live: real,
  });
});

router.post('/api/sync/now', (_req, res) => {
  const db = getDb();
  db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES ('in', 'Manual sync requested', 'queued', NULL)`).run();
  res.json({ ok: true, live: false });
});

router.post('/api/sync/objects/:object', (req, res) => {
  const db = getDb();
  const object = String(req.params.object);
  const direction = req.body?.direction;
  const enabled = req.body?.enabled;
  const row = db.prepare(`SELECT object FROM sync_objects WHERE object = ?`).get(object);
  if (!row) return res.status(404).json({ ok: false, error: 'unknown object' });
  if (direction) db.prepare(`UPDATE sync_objects SET direction = ? WHERE object = ?`).run(String(direction), object);
  if (enabled !== undefined) db.prepare(`UPDATE sync_objects SET enabled = ? WHERE object = ?`).run(enabled ? 1 : 0, object);
  res.json({ ok: true, live: false });
});

router.post('/api/sync/conflicts/:id/resolve', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const choice = String(req.body?.choice || '');
  const map: Record<string, string> = { ours: 'kept_ours', theirs: 'kept_theirs', both: 'kept_both' };
  const status = map[choice];
  if (!status) return res.status(400).json({ ok: false, error: 'invalid choice' });
  const c = db.prepare(`SELECT object FROM sync_conflicts WHERE id = ? AND status = 'open'`).get(id) as { object: string } | undefined;
  if (c) {
    db.prepare(`UPDATE sync_conflicts SET status = ?, resolved_by = 'Devon', resolved_at = datetime('now') WHERE id = ?`).run(status, id);
    const dir = choice === 'ours' ? 'out' : choice === 'theirs' ? 'in' : 'both';
    const text = choice === 'ours' ? 'Kept our value & pushed' : choice === 'theirs' ? 'Kept ServiceTrade value' : 'Kept both as contacts';
    db.prepare(`INSERT INTO sync_log (direction, text, state, object) VALUES (?, ?, 'applied', ?)`).run(dir, text, c.object);
  }
  res.json({ ok: true, live: false });
});

export default router;
