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
import { catalogAll, addCatalogItem, updateCatalogItem, removeCatalogItem } from '../services/onboardingCatalog';
import { importComputers } from '../services/rmmImport';
import * as sw from '../services/softwareLicenses';
import { graphConfigured, listAllGroups } from '../services/msGraphGroups';
import { getDb } from '../db/index';
import { rosterCsv, employeeDataGaps } from '../services/peopleRoster';

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

/* ── the editable onboarding form catalog (computers, software, SharePoint groups, printers) ── */
router.get('/api/onboarding-catalog', requirePeople(), (_req, res) => {
  res.json({ ok: true, catalog: catalogAll() });
});
router.post('/api/onboarding-catalog', requirePeople('people_admin', 'it', 'hr'), (req, res) => {
  const item = addCatalogItem(req.body || {}); // accepts group_name/group_id for access items
  if (!item) return res.status(400).json({ ok: false, error: 'invalid_item' });
  svc.audit('catalog_changed', `Onboarding catalog: added ${item.kind} "${item.name}"`, { actor: actor(req) });
  res.json({ ok: true, item });
});
router.put('/api/onboarding-catalog/:id', requirePeople('people_admin', 'it', 'hr'), (req, res) => {
  const item = updateCatalogItem(Number(req.params.id), req.body || {});
  if (!item) return res.status(404).json({ ok: false, error: 'not_found' });
  svc.audit('catalog_changed', `Onboarding catalog: edited ${item.kind} "${item.name}"`, { actor: actor(req) });
  res.json({ ok: true, item });
});
router.delete('/api/onboarding-catalog/:id', requirePeople('people_admin', 'it', 'hr'), (req, res) => {
  const ok = removeCatalogItem(Number(req.params.id));
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  svc.audit('catalog_changed', `Onboarding catalog: removed item ${req.params.id}`, { actor: actor(req) });
  res.json({ ok: true });
});

/* ─────────────────────────── employees ─────────────────────────── */
router.get('/api/people/employees', requirePeople(), (req, res) => {
  res.json({ employees: svc.listEmployees({ status: req.query.status as string, office: req.query.office as string, q: req.query.q as string }) });
});

/** Download the active-employee roster (name, position, office, email) as CSV. */
router.get('/api/people/roster-export', requirePeople(), (_req, res) => {
  const csv = rosterCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="active-employees.csv"');
  res.send(csv);
});

/** BambooHR data-gap report: active employees missing office / position / a stamped email. */
router.get('/api/people/data-gaps', requirePeople(), (_req, res) => {
  res.json({ ok: true, ...employeeDataGaps() });
});
router.get('/api/people/employees/:id', requirePeople(), (req, res) => {
  const detail = svc.getEmployeeDetail(Number(req.params.id), { includeComp: canViewCompensation((req as any).user) });
  if (!detail) return res.status(404).json({ ok: false, error: 'not found' });
  res.json(detail);
});

/* Import a computer export from the RMM into employee_assets, matched to employees. IT / admin only.
 * Preview by default; pass commit:true to write. Tolerant of most RMM column layouts. */
router.post('/api/people/assets/import-rmm', requirePeople('people_admin', 'it'), (req, res) => {
  const b = req.body || {};
  const csv = String(b.csv || '');
  if (!csv.trim()) return res.status(400).json({ ok: false, error: 'no CSV provided' });
  try {
    const out = importComputers(csv, actor(req), !!b.commit);
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/* Manual edits to an employee's record. Each change is written to the employee's history. Assets:
 * IT/HR/admin; Access: IT/admin; Credentials: HR/admin; a history note: any authorized People user. */
const edit = (fn: () => any, res: any) => {
  try { res.json({ ok: true, result: fn() }); }
  catch (err) { res.status(400).json({ ok: false, error: (err as Error).message }); }
};

router.post('/api/people/employees/:id/assets', requirePeople('people_admin', 'it', 'hr'), (req, res) =>
  edit(() => svc.addAsset(Number(req.params.id), req.body || {}, actor(req)), res));
router.post('/api/people/assets/:id/update', requirePeople('people_admin', 'it', 'hr'), (req, res) =>
  edit(() => svc.updateAsset(Number(req.params.id), req.body || {}, actor(req)), res));
router.post('/api/people/assets/:id/remove', requirePeople('people_admin', 'it', 'hr'), (req, res) =>
  edit(() => svc.removeAsset(Number(req.params.id), actor(req)), res));

router.post('/api/people/employees/:id/access', requirePeople('people_admin', 'it'), (req, res) =>
  edit(() => svc.addAccess(Number(req.params.id), req.body || {}, actor(req)), res));
router.post('/api/people/access/:id/update', requirePeople('people_admin', 'it'), (req, res) =>
  edit(() => svc.updateAccessStatus(Number(req.params.id), String((req.body || {}).status || ''), actor(req)), res));
router.post('/api/people/access/:id/remove', requirePeople('people_admin', 'it'), (req, res) =>
  edit(() => svc.removeAccess(Number(req.params.id), actor(req)), res));

/* Access wired to Microsoft 365: the security groups the OS knows, plus add/remove that actually
 * change Entra group membership via Graph. IT / admin only. */
router.get('/api/people/access/groups', requirePeople('people_admin', 'it'), async (req, res) => {
  // Default: the curated groups from the onboarding catalog (fast, no Graph call). ?all=1 pulls every
  // group straight from Entra so any group can be assigned.
  if (String(req.query.all || '') === '1') {
    const live = await listAllGroups();
    if (live.ok) { res.json({ ok: true, graphConfigured: true, all: true, groups: live.groups.map((g) => ({ name: g.name, id: g.id, kind: g.kind, mailbox: g.mailbox })) }); return; }
    res.json({ ok: true, graphConfigured: graphConfigured(), all: true, error: live.error, groups: svc.listAccessGroups() });
    return;
  }
  res.json({ ok: true, graphConfigured: graphConfigured(), groups: svc.listAccessGroups() });
});
router.post('/api/people/employees/:id/access/sync', requirePeople('people_admin', 'it'), async (req, res) => {
  try { res.json(await svc.syncAccessFromM365(Number(req.params.id), actor(req))); }
  catch (err) { res.status(400).json({ ok: false, error: (err as Error).message }); }
});
router.post('/api/people/access/sync-all', requirePeople('people_admin', 'it'), (req, res) => {
  try { res.json(svc.startBulkAccessSync(actor(req))); }
  catch (err) { res.status(400).json({ ok: false, error: (err as Error).message }); }
});
router.get('/api/people/access/sync-all/status', requirePeople('people_admin', 'it'), (_req, res) => {
  res.json({ ok: true, status: svc.bulkAccessSyncStatus() });
});

/* The active employees still without an Entra UPN, each with suggested M365 accounts to confirm-link. */
router.get('/api/people/identities/unmatched', requirePeople('people_admin', 'it', 'hr'), async (_req, res) => {
  try { res.json(await svc.unmatchedIdentitySuggestions()); }
  catch (err) { res.status(400).json({ ok: false, error: (err as Error).message }); }
});
router.post('/api/people/employees/:id/identity/link', requirePeople('people_admin', 'it', 'hr'), (req, res) => {
  const b = req.body || {};
  try { res.json(svc.linkIdentity(Number(req.params.id), String(b.upn || ''), b.display_name || null, actor(req))); }
  catch (err) { res.status(400).json({ ok: false, error: (err as Error).message }); }
});

/* Company-wide asset library (computers today; iPads/phones later). Any People user can view. */
router.get('/api/people/assets/library', requirePeople(), (req, res) => {
  res.json({ ok: true, tiers: svc.TIER_PRICES, tierLabels: svc.TIER_LABELS, ...svc.assetLibrary(String(req.query.type || 'computer')) });
});
router.post('/api/people/assets/:id/attrs', requirePeople('people_admin', 'it'), (req, res) => {
  const b = req.body || {};
  try { res.json(svc.setAssetAttributes(Number(req.params.id), { ram: b.ram, tier: b.tier }, actor(req))); }
  catch (err) { res.status(400).json({ ok: false, error: (err as Error).message }); }
});

/* Offboarding gaps: terminated people still enabled/licensed in Microsoft 365. IT / admin only. */
router.get('/api/people/offboarding/m365-gaps', requirePeople('people_admin', 'it'), async (_req, res) => {
  try { res.json(await svc.terminatedM365Gaps()); }
  catch (err) { res.status(400).json({ ok: false, error: (err as Error).message }); }
});

/* Paid-software licenses: the app catalog, plus CSV import that updates who holds each app. */
router.get('/api/people/software', requirePeople(), (_req, res) => res.json({ ok: true, ...sw.softwareOverview() }));
router.post('/api/people/software/apps', requirePeople('people_admin', 'it'), (req, res) => {
  const b = req.body || {};
  const app = sw.addSoftwareApp({ name: b.name, vendor: b.vendor, has_api: !!b.has_api, seats_paid: b.seats_paid, cost_per_seat: b.cost_per_seat });
  if (!app) return res.status(400).json({ ok: false, error: 'name_required' });
  res.json({ ok: true, app });
});
router.post('/api/people/software/import', requirePeople('people_admin', 'it'), (req, res) => {
  const b = req.body || {};
  res.json(sw.importSoftwareCsv(Number(b.app_id), String(b.csv || ''), !!b.commit));
});
// Stamp each employee's authoritative UPN/email from Entra so identity comes from Microsoft 365, not
// BambooHR. Read-only against the directory (needs User.Read.All).
router.post('/api/people/identities/sync', requirePeople('people_admin', 'it', 'hr'), async (req, res) => {
  try { res.json(await svc.syncIdentitiesFromM365(actor(req))); }
  catch (err) { res.status(400).json({ ok: false, error: (err as Error).message }); }
});
router.post('/api/people/employees/:id/access/group', requirePeople('people_admin', 'it'), async (req, res) => {
  const b = req.body || {};
  try {
    const out = await svc.provisionAccessGroup(Number(req.params.id), { group_name: String(b.group_name || ''), group_id: b.group_id || null }, actor(req));
    res.json(out);
  } catch (err) { res.status(400).json({ ok: false, error: (err as Error).message }); }
});
router.post('/api/people/access/:id/deprovision', requirePeople('people_admin', 'it'), async (req, res) => {
  try {
    const out = await svc.deprovisionAccessGroup(Number(req.params.id), actor(req));
    res.json(out);
  } catch (err) { res.status(400).json({ ok: false, error: (err as Error).message }); }
});

router.post('/api/people/employees/:id/credentials', requirePeople('people_admin', 'hr'), (req, res) =>
  edit(() => svc.addCredential(Number(req.params.id), req.body || {}, actor(req)), res));
router.post('/api/people/credentials/:id/update', requirePeople('people_admin', 'hr'), (req, res) =>
  edit(() => svc.updateCredential(Number(req.params.id), req.body || {}, actor(req)), res));
router.post('/api/people/credentials/:id/remove', requirePeople('people_admin', 'hr'), (req, res) =>
  edit(() => svc.removeCredential(Number(req.params.id), actor(req)), res));

router.post('/api/people/employees/:id/notes', requirePeople(), (req, res) =>
  edit(() => svc.addNote(Number(req.params.id), String((req.body || {}).text || ''), actor(req)), res));

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
