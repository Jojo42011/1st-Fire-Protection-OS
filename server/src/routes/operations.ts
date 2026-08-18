import { Router } from 'express';
import { getDb } from '../db/index';
import { currentContext, resolveOffice, officeScopeClause } from '../os/scope';
import { officeLabel } from '../os/office';

/**
 * Operations read models (Phase D): office-scoped summaries + lists for Service, Jobs, and Service
 * Agreements, built on the ServiceTrade mirror. Every query enforces the caller's office scope in
 * SQL via os_office_key(). Job readiness is a first pass at a configurable SOP: a completed job is
 * "ready to bill" only when it carries the office/entity and a customer contact accounting needs.
 */
const router = Router();

type ScopeOk = { clause: { sql: string; params: any[] }; office: string };
type ScopeErr = { error: { error: string; status: number } };
function scopeFor(req: any, column: string): ScopeOk | ScopeErr {
  const ctx = currentContext(req);
  const resolved = resolveOffice(ctx, req.query.office as string);
  if ('error' in resolved) return { error: resolved };
  return { clause: officeScopeClause(column, ctx, resolved.office), office: resolved.office };
}

/** Service management summary: the state of the service book, office-scoped. */
router.get('/api/operations/service', (req, res) => {
  const s = scopeFor(req, 'office_name');
  if ('error' in s) return res.status(s.error.status).json({ ok: false, error: s.error.error });
  const db = getDb();
  const n = (extra: string) => {
    try { return (db.prepare(`SELECT COUNT(*) v FROM crm_jobs WHERE source='servicetrade' AND ${s.clause.sql}${extra}`).get(...s.clause.params) as { v: number }).v || 0; }
    catch { return 0; }
  };
  res.json({
    ok: true,
    office: s.office,
    summary: {
      completed30: n(` AND completed_at IS NOT NULL AND julianday('now')-julianday(completed_at)<=30`),
      scheduled: n(` AND completed_at IS NULL AND scheduled_at IS NOT NULL`),
      needsScheduling: n(` AND completed_at IS NULL AND scheduled_at IS NULL`),
      openTotal: n(` AND completed_at IS NULL`),
      readyToBill: readyToBillCount(db, s.clause),
    },
  });
});

function readyToBillCount(db: any, clause: { sql: string; params: any[] }): number {
  try {
    return (db.prepare(
      `SELECT COUNT(*) v FROM crm_jobs WHERE source='servicetrade' AND completed_at IS NOT NULL
         AND office_name IS NOT NULL AND office_name!=''
         AND (COALESCE(contact_email,'')!='' OR COALESCE(contact_phone,'')!='')
         AND julianday('now')-julianday(completed_at)<=60 AND ${clause.sql}`
    ).get(...clause.params) as { v: number }).v || 0;
  } catch { return 0; }
}

/** Jobs list with a computed readiness state, office-scoped, filterable. */
router.get('/api/operations/jobs', (req, res) => {
  const s = scopeFor(req, 'office_name');
  if ('error' in s) return res.status(s.error.status).json({ ok: false, error: s.error.error });
  const db = getDb();
  const state = String(req.query.state || 'attention');
  let extra = '';
  if (state === 'active') extra = ` AND completed_at IS NULL`;
  else if (state === 'completed') extra = ` AND completed_at IS NOT NULL`;
  else if (state === 'ready') extra = ` AND completed_at IS NOT NULL AND office_name IS NOT NULL AND office_name!='' AND (COALESCE(contact_email,'')!='' OR COALESCE(contact_phone,'')!='')`;
  else if (state === 'attention') extra = ` AND ((completed_at IS NOT NULL AND (office_name IS NULL OR office_name='' OR (COALESCE(contact_email,'')='' AND COALESCE(contact_phone,'')=''))) OR (completed_at IS NULL AND scheduled_at IS NULL))`;
  let rows: any[] = [];
  try {
    rows = db.prepare(
      `SELECT id, number, kind, status, office_name, contact_name, contact_email, contact_phone, scheduled_at, completed_at, deficiency_count
         FROM crm_jobs WHERE source='servicetrade' AND ${s.clause.sql}${extra}
        ORDER BY COALESCE(completed_at, scheduled_at) DESC LIMIT 150`
    ).all(...s.clause.params) as any[];
  } catch { rows = []; }
  const jobs = rows.map((j) => {
    const missing: string[] = [];
    if (!j.office_name) missing.push('office/entity');
    if (!j.contact_email && !j.contact_phone) missing.push('customer contact');
    const ready = j.completed_at && missing.length === 0;
    return {
      id: j.id, number: j.number, kind: j.kind, status: j.status,
      office: j.office_name || null, contact: j.contact_name || null,
      scheduled_at: j.scheduled_at, completed_at: j.completed_at, deficiencies: j.deficiency_count || 0,
      readiness: j.completed_at ? (ready ? 'ready' : 'blocked') : (j.scheduled_at ? 'scheduled' : 'needs_scheduling'),
      missing,
    };
  });
  res.json({ ok: true, office: s.office, jobs });
});

/** Service agreements: active book + what's ending soon, office-scoped. */
router.get('/api/operations/agreements', (req, res) => {
  const s = scopeFor(req, 'office');
  if ('error' in s) return res.status(s.error.status).json({ ok: false, error: s.error.error });
  const db = getDb();
  const n = (extra: string) => {
    try { return (db.prepare(`SELECT COUNT(*) v FROM service_recurrences WHERE ${s.clause.sql}${extra}`).get(...s.clause.params) as { v: number }).v || 0; }
    catch { return 0; }
  };
  let rows: any[] = [];
  try {
    rows = db.prepare(
      `SELECT st_id, description, location_name, office, frequency, ends_on, price_cents
         FROM service_recurrences WHERE ${s.clause.sql}
        ORDER BY (ends_on IS NULL), ends_on ASC LIMIT 150`
    ).all(...s.clause.params) as any[];
  } catch { rows = []; }
  res.json({
    ok: true,
    office: s.office,
    summary: {
      active: n(''),
      endingSoon: n(` AND ends_on IS NOT NULL AND julianday(ends_on)-julianday('now') BETWEEN 0 AND 90`),
      ended: n(` AND ends_on IS NOT NULL AND ends_on < date('now')`),
    },
    agreements: rows.map((r) => ({
      id: r.st_id, site: r.location_name, office: r.office ? officeLabel(r.office) : null,
      frequency: r.frequency, ends_on: r.ends_on, value: r.price_cents != null ? Math.round(r.price_cents / 100) : null,
    })),
  });
});

export default router;
