import { Router } from 'express';
import { getDb } from '../db/index';
import { canonicalOffice } from '../os/office';

/**
 * After-hours on-call roster, per office. This is the one net-new data source the AI
 * receptionist's after-hours flow depends on: when a call comes in after hours, the bridge
 * asks GET /api/oncall/current?office=<office> to learn who to warm-transfer to.
 *
 * A shift is one person covering one office over a [starts_on, ends_on) date window. A weekly
 * rotation is a run of consecutive one-week shifts cycling through a pool of people, which the
 * /rotate endpoint generates in one shot. Everything is office-scoped; office is normalized to
 * the friendly label so it matches whatever the global office switcher passes.
 */
const router = Router();

/** Normalize any office string to the OS canonical office key (same identity as every other object). */
function shortLabel(o: string): string {
  return canonicalOffice(o) || (o || '').trim();
}

/** YYYY-MM-DD for a Date, using its UTC fields (we treat dates as tz-free calendar days). */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}
function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

interface Shift {
  id: number;
  office: string;
  person_name: string;
  person_phone: string | null;
  person_email: string | null;
  starts_on: string;
  ends_on: string;
  note: string | null;
  source: string;
}

/** The person on call for an office right now, or null. */
function currentFor(office: string): Shift | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM oncall_shifts
        WHERE os_office_key(office) = @office AND date('now','localtime') >= starts_on AND date('now','localtime') < ends_on
        ORDER BY starts_on DESC LIMIT 1`
    )
    .get({ office }) as Shift | undefined;
  return row || null;
}

/**
 * GET /api/oncall/current?office=<office>
 * The integration point the receptionist bridge reads. With an office, returns that office's
 * current on-call (or null). Without one, returns a map of every office that has any roster.
 */
router.get('/api/oncall/current', (req, res) => {
  const raw = String(req.query.office || '').trim();
  if (raw && raw !== 'all') {
    const office = shortLabel(raw);
    const onCall = currentFor(office);
    return res.json({ office, onCall, live: !!onCall });
  }
  const offices = getDb()
    .prepare(`SELECT DISTINCT office FROM oncall_shifts ORDER BY office`)
    .all() as { office: string }[];
  const byOffice: Record<string, Shift | null> = {};
  for (const o of offices) byOffice[o.office] = currentFor(o.office);
  res.json({ byOffice });
});

/**
 * GET /api/oncall?office=<office>
 * The roster screen: current on-call plus the shift schedule (recent + all upcoming).
 */
router.get('/api/oncall', (req, res) => {
  const raw = String(req.query.office || '').trim();
  const office = raw && raw !== 'all' ? shortLabel(raw) : '';
  const db = getDb();
  const where = office ? `WHERE os_office_key(office) = @office AND ends_on >= date('now','localtime','-14 day')` : `WHERE ends_on >= date('now','localtime','-14 day')`;
  const shifts = db
    .prepare(`SELECT * FROM oncall_shifts ${where} ORDER BY starts_on ASC, office ASC LIMIT 400`)
    .all(...(office ? [{ office }] : [])) as Shift[];
  const current = office ? currentFor(office) : null;
  res.json({ office: office || 'all', current, shifts });
});

/** POST /api/oncall  — add a single shift. */
router.post('/api/oncall', (req, res) => {
  const b = req.body || {};
  const office = shortLabel(String(b.office || '').trim());
  const person_name = String(b.person_name || '').trim();
  const starts_on = String(b.starts_on || '').trim();
  const ends_on = String(b.ends_on || '').trim();
  if (!office || office === 'all') return res.status(400).json({ ok: false, error: 'pick a specific office' });
  if (!person_name) return res.status(400).json({ ok: false, error: 'person_name required' });
  if (!isDate(starts_on) || !isDate(ends_on)) return res.status(400).json({ ok: false, error: 'starts_on and ends_on must be YYYY-MM-DD' });
  if (ends_on <= starts_on) return res.status(400).json({ ok: false, error: 'ends_on must be after starts_on' });
  const info = getDb()
    .prepare(
      `INSERT INTO oncall_shifts (office, person_name, person_phone, person_email, starts_on, ends_on, note, source)
       VALUES (@office,@person_name,@person_phone,@person_email,@starts_on,@ends_on,@note,'manual')`
    )
    .run({
      office,
      person_name,
      person_phone: String(b.person_phone || '').trim() || null,
      person_email: String(b.person_email || '').trim() || null,
      starts_on,
      ends_on,
      note: String(b.note || '').trim() || null,
    });
  res.json({ ok: true, id: info.lastInsertRowid });
});

/**
 * POST /api/oncall/rotate  — generate a weekly rotation in one shot.
 * body: { office, start (YYYY-MM-DD), weeks, people:[{name,phone,email}], replaceFuture? }
 * Creates `weeks` consecutive one-week shifts cycling through people. When replaceFuture is
 * set, existing shifts on/after `start` for that office are cleared first (re-generate cleanly).
 */
router.post('/api/oncall/rotate', (req, res) => {
  const b = req.body || {};
  const office = shortLabel(String(b.office || '').trim());
  const start = String(b.start || '').trim();
  const weeks = Math.max(1, Math.min(104, Number(b.weeks) || 0));
  const people = Array.isArray(b.people) ? b.people : [];
  if (!office || office === 'all') return res.status(400).json({ ok: false, error: 'pick a specific office' });
  if (!isDate(start)) return res.status(400).json({ ok: false, error: 'start must be YYYY-MM-DD' });
  const clean = people
    .map((p: any) => ({
      name: String(p?.name || '').trim(),
      phone: String(p?.phone || '').trim() || null,
      email: String(p?.email || '').trim() || null,
    }))
    .filter((p: { name: string }) => p.name);
  if (!clean.length) return res.status(400).json({ ok: false, error: 'add at least one person' });

  const db = getDb();
  const tx = db.transaction(() => {
    if (b.replaceFuture) {
      db.prepare(`DELETE FROM oncall_shifts WHERE office = @office AND starts_on >= @start`).run({ office, start });
    }
    const ins = db.prepare(
      `INSERT INTO oncall_shifts (office, person_name, person_phone, person_email, starts_on, ends_on, note, source)
       VALUES (@office,@name,@phone,@email,@s,@e,NULL,'rotation')`
    );
    let created = 0;
    for (let i = 0; i < weeks; i++) {
      const p = clean[i % clean.length];
      const s = addDays(start, i * 7);
      const e = addDays(start, (i + 1) * 7);
      ins.run({ office, name: p.name, phone: p.phone, email: p.email, s, e });
      created++;
    }
    return created;
  });
  const created = tx();
  res.json({ ok: true, created, current: currentFor(office) });
});

/** POST /api/oncall/:id/delete  — remove one shift. */
router.post('/api/oncall/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad id' });
  getDb().prepare(`DELETE FROM oncall_shifts WHERE id = ?`).run(id);
  res.json({ ok: true });
});

export default router;
