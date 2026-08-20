/**
 * People / Employee Lifecycle API. Every route except the identity/login endpoints is behind
 * server-enforced authorization (authz.requirePeople). Compensation data is HR-gated. Approvals
 * can only be decided by a holder of the mapped approver role; provisioning tasks can only be
 * completed by the owning team (or a people_admin).
 */
import { Router } from 'express';
import { catalogSnapshot } from '../people/catalog';
import { entraConfigured, devLoginEnabled, beginLogin, handleCallback, signOut, currentIdentity } from '../people/identity';
import { currentUser, requirePeople, hasRole, canViewCompensation, canApprove, listAppUsers, upsertAppUser, setAppUserActive, ROLES, Role } from '../people/authz';
import { getMatrix, saveRoleLevels, resetRoleLevels } from '../people/permissions';
import * as svc from '../people/service';
import { bambooConfigured } from '../services/bamboo';
import { operatingOffices } from '../os/office';
import { getDb } from '../db/index';

const router = Router();
const actor = (req: any): string => (req.user?.email as string) || 'system';

/* ─────────────────────────── identity / sign-in (open: reports state, starts login) ─────────────────────────── */
router.get('/api/people/me', (req, res) => {
  const id = currentIdentity(req);
  const user = currentUser(req);
  res.json({
    entraConfigured: entraConfigured(),
    devLogin: devLoginEnabled(),
    authenticated: !!id,
    email: id?.email || null,
    name: user?.display_name || id?.name || null,
    roles: user?.roles || [],
    authorized: !!user,
    roleCatalog: ROLES,
  });
});
router.get('/api/people/auth/login', beginLogin);
router.get('/api/people/auth/callback', handleCallback);
router.post('/api/people/auth/logout', (_req, res) => { signOut(res); res.json({ ok: true }); });

/* ─────────────────────────── catalogs + overview (any People role) ─────────────────────────── */
router.get('/api/people/catalog', requirePeople(), (_req, res) => {
  const vendors = getDb().prepare(`SELECT key, name, owner FROM vendor_portals WHERE active = 1 ORDER BY name`).all();
  res.json({ ...catalogSnapshot(), vendorPortals: vendors, bambooConnected: bambooConfigured() });
});
router.get('/api/people/overview', requirePeople(), (_req, res) => res.json(svc.overview()));
router.get('/api/people/attention', requirePeople(), (_req, res) => res.json({ ok: true, attention: svc.peopleAttention(), startingSoon: svc.startingSoon(7) }));
router.get('/api/people/assets', requirePeople(), (req, res) => res.json({ ok: true, assets: svc.listAssets((req.query.view as string) || 'assigned') }));
router.get('/api/people/credentials', requirePeople(), (req, res) => res.json({ ok: true, credentials: svc.listCredentials((req.query.view as string) || 'expiring') }));

/* ─────────────────────────── positions + role templates ─────────────────────────── */
router.get('/api/people/positions', requirePeople(), (_req, res) => {
  const rows = getDb().prepare(
    `SELECT p.name, p.active, t.review_status, t.defaults_json, t.updated_at
       FROM job_positions p LEFT JOIN role_templates t ON t.position = p.name ORDER BY p.name`
  ).all();
  res.json({ positions: rows });
});
router.get('/api/people/templates/:position', requirePeople(), (req, res) => {
  const row = getDb().prepare(`SELECT position, review_status, defaults_json, updated_by, updated_at FROM role_templates WHERE position = ?`).get(req.params.position);
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  res.json(row);
});
router.put('/api/people/templates/:position', requirePeople('people_admin', 'hr', 'it'), (req, res) => {
  const defaults = req.body?.defaults ?? {};
  const review = req.body?.review_status === 'reviewed' ? 'reviewed' : 'unreviewed';
  getDb().prepare(`UPDATE role_templates SET defaults_json = ?, review_status = ?, updated_by = ?, updated_at = datetime('now') WHERE position = ?`)
    .run(JSON.stringify(defaults), review, actor(req), req.params.position);
  svc.audit('role_changed', `Role template updated: ${req.params.position} (${review})`, { actor: actor(req) });
  res.json({ ok: true });
});

/* ─────────────────────────── employees ─────────────────────────── */
router.get('/api/people/employees', requirePeople(), (req, res) => {
  res.json({ employees: svc.listEmployees({ status: req.query.status as string, office: req.query.office as string, q: req.query.q as string }) });
});
router.get('/api/people/employees/:id', requirePeople(), (req, res) => {
  const detail = svc.getEmployeeDetail(Number(req.params.id), { includeComp: canViewCompensation((req as any).user) });
  if (!detail) return res.status(404).json({ ok: false, error: 'not found' });
  res.json(detail);
});

/* Import the real BambooHR roster (idempotent upsert by bamboo_id). HR / admin only. */
router.post('/api/people/import/bamboo', requirePeople('people_admin', 'hr'), async (req, res) => {
  try {
    const out = await svc.importFromBamboo(actor(req));
    if (!out.ok) return res.status(out.reason === 'bamboo_not_connected' ? 409 : 502).json(out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/* ─────────────────────────── onboarding ─────────────────────────── */
router.post('/api/people/onboarding', requirePeople('manager', 'hr', 'people_admin'), (req, res) => {
  try {
    const b = req.body || {};
    if (!b.legal_first_name && !b.preferred_name) return res.status(400).json({ ok: false, error: 'name required' });
    const out = svc.createOnboarding(b, actor(req));
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

/* ─────────────────────────── tasks (My Tasks + decisions) ─────────────────────────── */
router.get('/api/people/tasks', requirePeople(), (req, res) => {
  const user = (req as any).user;
  const mine = req.query.mine === '1';
  // "mine": tasks owned by a team the user can act for, plus approvals they can decide.
  const team = mine ? undefined : (req.query.team as string);
  let tasks = svc.listTasks({ team, status: (req.query.status as string) || undefined, employee_id: req.query.employee_id ? Number(req.query.employee_id) : undefined });
  if (mine) {
    tasks = tasks.filter((t: any) =>
      (t.kind === 'task' && hasRole(user, t.team as Role)) ||
      (t.kind === 'approval' && canApprove(user, t.approver_role))
    );
  }
  res.json({ tasks });
});
router.post('/api/people/tasks/:id/complete', requirePeople(), (req, res) => {
  try {
    const t = getDb().prepare(`SELECT team, kind FROM people_tasks WHERE id = ?`).get(Number(req.params.id)) as { team: string; kind: string } | undefined;
    if (!t) return res.status(404).json({ ok: false, error: 'not found' });
    if (t.kind !== 'task') return res.status(400).json({ ok: false, error: 'use approve/reject for approvals' });
    if (!hasRole((req as any).user, t.team as Role)) return res.status(403).json({ ok: false, error: 'forbidden', need: [t.team] });
    res.json({ ok: true, task: svc.completeTask(Number(req.params.id), actor(req)) });
  } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
});
router.post('/api/people/tasks/:id/approve', requirePeople(), (req, res) => {
  try {
    const t = getDb().prepare(`SELECT approver_role, kind FROM people_tasks WHERE id = ?`).get(Number(req.params.id)) as { approver_role: string; kind: string } | undefined;
    if (!t) return res.status(404).json({ ok: false, error: 'not found' });
    if (!canApprove((req as any).user, t.approver_role)) return res.status(403).json({ ok: false, error: 'forbidden', need: [t.approver_role] });
    res.json({ ok: true, task: svc.approveTask(Number(req.params.id), actor(req)) });
  } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
});
router.post('/api/people/tasks/:id/reject', requirePeople(), (req, res) => {
  try {
    const t = getDb().prepare(`SELECT approver_role FROM people_tasks WHERE id = ?`).get(Number(req.params.id)) as { approver_role: string } | undefined;
    if (!t) return res.status(404).json({ ok: false, error: 'not found' });
    if (!canApprove((req as any).user, t.approver_role)) return res.status(403).json({ ok: false, error: 'forbidden' });
    res.json({ ok: true, task: svc.rejectTask(Number(req.params.id), actor(req), req.body?.note) });
  } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
});

/* ─────────────────────────── offboarding ─────────────────────────── */
router.post('/api/people/offboarding', requirePeople('hr', 'people_admin', 'manager'), (req, res) => {
  try {
    const b = req.body || {};
    if (!b.employee_id) return res.status(400).json({ ok: false, error: 'employee_id required' });
    const out = svc.startOffboarding(Number(b.employee_id), b, actor(req));
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
});

/* ─────────────────────────── app users / roles (admin) ─────────────────────────── */
router.get('/api/people/users', requirePeople('people_admin'), (_req, res) => res.json({ users: listAppUsers(), roles: ROLES, offices: operatingOffices() }));
router.post('/api/people/users', requirePeople('people_admin'), (req, res) => {
  const { email, roles, display_name, offices, all_offices } = req.body || {};
  if (!email || !Array.isArray(roles)) return res.status(400).json({ ok: false, error: 'email + roles[] required' });
  const scope = { offices: Array.isArray(offices) ? offices.map(String) : [], all_offices: !!all_offices };
  const u = upsertAppUser(String(email), roles as Role[], display_name, scope);
  const scopeStr = u.all_offices ? 'all offices' : (u.offices.join(', ') || 'no office');
  svc.audit('access_requested', `Access set: ${u.email} = roles [${u.roles.join(', ')}], scope [${scopeStr}]`, { actor: actor(req) });
  res.json({ ok: true, user: u });
});
router.post('/api/people/users/:email/active', requirePeople('people_admin'), (req, res) => {
  setAppUserActive(req.params.email, req.body?.active !== false);
  res.json({ ok: true });
});

/* ─────────────────────────── role x module matrix (admin) ─────────────────────────── */
router.get('/api/people/roles/matrix', requirePeople('people_admin'), (_req, res) => {
  res.json({ ok: true, ...getMatrix(), roleCatalog: ROLES });
});
router.put('/api/people/roles/:role/matrix', requirePeople('people_admin'), (req, res) => {
  try {
    const levels = saveRoleLevels(req.params.role, req.body?.levels || {}, actor(req));
    svc.audit('role_changed', `Access matrix updated for role ${req.params.role}`, { actor: actor(req) });
    res.json({ ok: true, role: req.params.role, levels });
  } catch (e) {
    res.status((e as Error).message === 'unknown_role' ? 404 : 400).json({ ok: false, error: (e as Error).message });
  }
});
router.post('/api/people/roles/:role/matrix/reset', requirePeople('people_admin'), (req, res) => {
  try {
    const levels = resetRoleLevels(req.params.role);
    svc.audit('role_changed', `Access matrix reset to preset for role ${req.params.role}`, { actor: actor(req) });
    res.json({ ok: true, role: req.params.role, levels });
  } catch (e) {
    res.status((e as Error).message === 'unknown_role' ? 404 : 400).json({ ok: false, error: (e as Error).message });
  }
});

export default router;
