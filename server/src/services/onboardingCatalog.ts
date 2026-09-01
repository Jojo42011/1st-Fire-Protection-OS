/**
 * The editable onboarding form catalog: the computers, software, SharePoint groups, and printers the
 * onboarding form offers. These are company-specific and change over time, so they live in the
 * database and a People admin edits them, rather than being hardcoded. The onboarding router reads
 * its routing (which team an item goes to, and whether it needs approval) from the same rows.
 */
import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { operatingOffices } from '../os/office';

export type CatalogKind = 'computer' | 'software' | 'sharepoint' | 'printer' | 'sage' | 'servicetrade';
export interface CatalogItem {
  id: number;
  kind: CatalogKind;
  name: string;
  spec: string | null;
  owner: string;
  approval: boolean;
  group_name: string | null; // Entra security group name (SG-PR-MCA), for access items
  group_id: string | null; // Entra group object id (GUID)
  price: number | null; // optional per-seat price (Sage/ServiceTrade roles)
  sort: number;
  active: boolean;
}

/** Seed sensible starting values once, so a fresh install has a usable (and editable) catalog.
 *  Computers are described by role, not bound to a specific laptop model, so the list does not go
 *  stale when hardware changes. Idempotent via a state flag. */
export function seedOnboardingCatalog(): void {
  if (getState('seeded_onboarding_catalog_v1') === '1') return;
  const db = getDb();
  const existing = db.prepare(`SELECT COUNT(*) AS c FROM onboarding_catalog`).get() as { c: number };
  if (existing.c > 0) {
    setState('seeded_onboarding_catalog_v1', '1');
    return;
  }
  const ins = db.prepare(
    `INSERT INTO onboarding_catalog (kind, name, spec, owner, approval, sort) VALUES (@kind, @name, @spec, @owner, @approval, @sort)`
  );
  const rows: { kind: CatalogKind; name: string; spec?: string; owner?: string; approval?: number }[] = [
    // Computers: described by role, not tied to a model number.
    { kind: 'computer', name: 'Standard', spec: 'Everyday laptop for office and field work' },
    { kind: 'computer', name: 'Business', spec: 'Heavier multitasking for power users' },
    { kind: 'computer', name: 'CAD', spec: 'Design workstation with dedicated graphics' },
    // Software: the common set, routed to IT unless it needs an owner license approval. Napco added;
    // the admin adds the rest of the company's software from the editor.
    { kind: 'software', name: 'Microsoft 365 desktop apps', owner: 'it' },
    { kind: 'software', name: 'Adobe Acrobat', owner: 'it' },
    { kind: 'software', name: 'HFSS', owner: 'it' },
    { kind: 'software', name: 'Napco', owner: 'it' },
    { kind: 'software', name: 'Bluebeam', owner: 'mario', approval: 1 },
    { kind: 'software', name: 'AutoCAD', owner: 'mario', approval: 1 },
    { kind: 'software', name: 'HydraCAD', owner: 'mario', approval: 1 },
    // SharePoint groups: one per real office, plus the standard function groups.
    ...operatingOffices().map((o) => ({ kind: 'sharepoint' as CatalogKind, name: o.label, owner: 'it' })),
    { kind: 'sharepoint', name: 'SAFETY', owner: 'it' },
    { kind: 'sharepoint', name: 'MGMT', owner: 'mario', approval: 1 },
    { kind: 'sharepoint', name: 'ACCT', owner: 'rebecca', approval: 1 },
    { kind: 'sharepoint', name: 'Payroll', owner: 'rebecca', approval: 1 },
    { kind: 'sharepoint', name: 'HR', owner: 'sandi', approval: 1 },
    // Printers: none by default; the admin adds the company's real printers.
  ];
  const tx = db.transaction(() => {
    rows.forEach((r, i) =>
      ins.run({ kind: r.kind, name: r.name, spec: r.spec ?? null, owner: r.owner ?? 'it', approval: r.approval ?? 0, sort: i })
    );
  });
  tx();
  setState('seeded_onboarding_catalog_v1', '1');
}

function toItem(r: any): CatalogItem {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    spec: r.spec ?? null,
    owner: r.owner || 'it',
    approval: r.approval === 1,
    group_name: r.group_name ?? null,
    group_id: r.group_id ?? null,
    price: r.price ?? null,
    sort: r.sort ?? 0,
    active: r.active === 1,
  };
}

/** All active items of one kind, in sort order. */
export function catalogByKind(kind: CatalogKind): CatalogItem[] {
  return (getDb().prepare(`SELECT * FROM onboarding_catalog WHERE kind = ? AND active = 1 ORDER BY sort, id`).all(kind) as any[]).map(toItem);
}

// The printer access maps to per-office Entra security groups (SG-PR-<office>). Selecting an office's
// printers on the onboarding form adds the hire to that group. Object ids provided from the tenant;
// Laredo and Extinguishers have no group yet (fill them in the catalog editor). Seeded once.
const PRINTER_GROUPS: { office: string; group: string; id: string | null }[] = [
  { office: 'Austin', group: 'SG-PR-AUS', id: '93d55e89-ccb8-420c-918f-83d967793886' },
  { office: 'Houston', group: 'SG-PR-HOU', id: 'd78fdb5f-d95a-4399-9d96-42a9902b844c' },
  { office: 'McAllen', group: 'SG-PR-MCA', id: '0a1ef322-d4c3-4801-b3e8-771dffd3c5b7' },
  { office: 'Waco', group: 'SG-PR-WAC', id: '8ef7eebe-6e60-4041-a19f-28dccfb6f5e1' },
  { office: 'Lubbock', group: 'SG-PR-LUB', id: '9d8131cf-045b-40f4-a8ef-d815ab3b4c21' },
  { office: 'College Station', group: 'SG-PR-CST', id: 'bc5c193e-48e5-4ca8-a1df-40a3a418653e' },
  { office: 'Services (San Antonio)', group: 'SG-PR-SAT', id: '3cd4a9c5-9126-4fba-bbb6-30b78d41b9dc' },
  { office: 'OSC', group: 'SG-PR-OSC', id: 'b33cdea5-2c36-4904-b32e-de4dd8742f7e' },
  { office: 'Laredo', group: '', id: null },
  { office: 'Extinguishers', group: '', id: null },
];

/** Seed the per-office printer security groups. Idempotent: skips any printer already present by
 *  group name or office label, and only runs once via a state flag. */
export function seedPrinterGroups(): void {
  if (getState('seeded_printer_groups_v1') === '1') return;
  const db = getDb();
  const exists = db.prepare(`SELECT 1 FROM onboarding_catalog WHERE kind = 'printer' AND (group_name = ? OR name = ?) LIMIT 1`);
  let sort = (db.prepare(`SELECT COALESCE(MAX(sort), -1) AS m FROM onboarding_catalog WHERE kind = 'printer'`).get() as { m: number }).m;
  const ins = db.prepare(
    `INSERT INTO onboarding_catalog (kind, name, owner, approval, group_name, group_id, sort) VALUES ('printer', ?, 'it', 0, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const p of PRINTER_GROUPS) {
      if (exists.get(p.group || '__none__', p.office)) continue;
      ins.run(p.office, p.group || null, p.id, ++sort);
    }
  });
  tx();
  setState('seeded_printer_groups_v1', '1');
}

/** Every active item, grouped by kind (for the editor and the form option catalogs). */
export function catalogAll(): Record<CatalogKind, CatalogItem[]> {
  return {
    computer: catalogByKind('computer'),
    software: catalogByKind('software'),
    sharepoint: catalogByKind('sharepoint'),
    printer: catalogByKind('printer'),
    sage: catalogByKind('sage'),
    servicetrade: catalogByKind('servicetrade'),
  };
}

const KINDS: CatalogKind[] = ['computer', 'software', 'sharepoint', 'printer', 'sage', 'servicetrade'];

/** Seed the Sage and ServiceTrade role options once. Idempotent (skips a role already present by
 *  kind+name), so it also backfills existing databases. */
export function seedAppAccessCatalog(): void {
  const db = getDb();
  const exists = db.prepare(`SELECT 1 FROM onboarding_catalog WHERE kind = ? AND name = ? LIMIT 1`);
  const ins = db.prepare(
    `INSERT INTO onboarding_catalog (kind, name, spec, owner, approval, price, sort) VALUES (@kind, @name, @spec, @owner, @approval, @price, @sort)`
  );
  const rows: { kind: CatalogKind; name: string; spec: string; owner: string; approval: number; price: number | null }[] = [
    // Sage (routes to Accounting / Rebecca Koen), priced per seat.
    { kind: 'sage', name: 'Business user', spec: 'Create customer invoicing; push and edit data that comes in from Service Trade', owner: 'rebecca', approval: 1, price: 2750 },
    { kind: 'sage', name: 'Construction Manager', spec: 'Full view of all projects and Purchase Order Entry', owner: 'rebecca', approval: 1, price: 378 },
    { kind: 'sage', name: 'Employee', spec: 'View only with limited access', owner: 'rebecca', approval: 1, price: 148.5 },
    // ServiceTrade (routes to Laura Shannon).
    { kind: 'servicetrade', name: 'Technician', spec: '', owner: 'laura', approval: 0, price: null },
    { kind: 'servicetrade', name: 'Sales', spec: '', owner: 'laura', approval: 0, price: null },
    { kind: 'servicetrade', name: 'Admin', spec: '', owner: 'laura', approval: 0, price: null },
  ];
  const tx = db.transaction(() => {
    let sort = 0;
    for (const r of rows) {
      if (exists.get(r.kind, r.name)) continue;
      ins.run({ kind: r.kind, name: r.name, spec: r.spec || null, owner: r.owner, approval: r.approval, price: r.price, sort: sort++ });
    }
  });
  tx();
}

/** Add an item. Returns the created row, or null if the kind/name is invalid. */
export function addCatalogItem(input: { kind: string; name: string; spec?: string; owner?: string; approval?: boolean; group_name?: string; group_id?: string; price?: number | null }): CatalogItem | null {
  const kind = input.kind as CatalogKind;
  const name = (input.name || '').trim();
  if (!KINDS.includes(kind) || !name) return null;
  const db = getDb();
  const maxSort = (db.prepare(`SELECT COALESCE(MAX(sort), -1) AS m FROM onboarding_catalog WHERE kind = ?`).get(kind) as { m: number }).m;
  const price = input.price === undefined || input.price === null || isNaN(Number(input.price)) ? null : Number(input.price);
  const info = db
    .prepare(`INSERT INTO onboarding_catalog (kind, name, spec, owner, approval, group_name, group_id, price, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(kind, name, input.spec ?? null, input.owner || 'it', input.approval ? 1 : 0, input.group_name?.trim() || null, input.group_id?.trim() || null, price, maxSort + 1);
  return toItem(db.prepare(`SELECT * FROM onboarding_catalog WHERE id = ?`).get(Number(info.lastInsertRowid)));
}

/** Edit an item's fields. Returns the updated row, or null if it does not exist. */
export function updateCatalogItem(id: number, patch: { name?: string; spec?: string; owner?: string; approval?: boolean; group_name?: string; group_id?: string; price?: number | null }): CatalogItem | null {
  const db = getDb();
  const cur = db.prepare(`SELECT * FROM onboarding_catalog WHERE id = ?`).get(id) as any;
  if (!cur) return null;
  const name = patch.name != null ? patch.name.trim() || cur.name : cur.name;
  const spec = patch.spec !== undefined ? (patch.spec || null) : cur.spec;
  const owner = patch.owner != null ? patch.owner : cur.owner;
  const approval = patch.approval != null ? (patch.approval ? 1 : 0) : cur.approval;
  const groupName = patch.group_name !== undefined ? (patch.group_name.trim() || null) : cur.group_name;
  const groupId = patch.group_id !== undefined ? (patch.group_id.trim() || null) : cur.group_id;
  const price = patch.price !== undefined ? (patch.price === null || isNaN(Number(patch.price)) ? null : Number(patch.price)) : cur.price;
  db.prepare(`UPDATE onboarding_catalog SET name = ?, spec = ?, owner = ?, approval = ?, group_name = ?, group_id = ?, price = ? WHERE id = ?`).run(name, spec, owner, approval, groupName, groupId, price, id);
  return toItem(db.prepare(`SELECT * FROM onboarding_catalog WHERE id = ?`).get(id));
}

/** Soft-remove an item (kept for any in-flight references, hidden from the form). */
export function removeCatalogItem(id: number): boolean {
  return getDb().prepare(`UPDATE onboarding_catalog SET active = 0 WHERE id = ?`).run(id).changes > 0;
}

// Sensitive SG-SP groups keep their approval routing when synced into the form.
const SP_ROUTING: Record<string, { owner: string; approval: boolean }> = {
  'sg-sp-accounting': { owner: 'rebecca', approval: true },
  'sg-sp-payroll': { owner: 'rebecca', approval: true },
  'sg-sp-management': { owner: 'mario', approval: true },
  'sg-sp-hr': { owner: 'sandi', approval: true },
};

/**
 * Put the real on-prem SG-SP-* security groups into the onboarding form's SharePoint list. Adds any
 * SG-SP-* group not already present (with its Entra group id, so it can auto-provision via Graph),
 * backfills group ids on existing SG-SP rows, and retires the old friendly-name rows so the form shows
 * the actual groups (whose names pass through to provisioning unchanged, instead of the broken
 * abbreviation transform). Idempotent. `groups` come from Entra (the caller does the Graph read).
 */
export function syncSharepointCatalog(groups: { id: string; name: string }[]): { added: number; retired: number; names: string[] } {
  const sg = groups.filter((g) => /^sg-sp-/i.test(g.name));
  const existing = new Map(catalogByKind('sharepoint').map((c) => [c.name.toLowerCase(), c]));
  let added = 0; const names: string[] = [];
  for (const g of sg) {
    const cur = existing.get(g.name.toLowerCase());
    if (cur) { if (!cur.group_id && g.id) updateCatalogItem(cur.id, { group_id: g.id }); continue; }
    const r = SP_ROUTING[g.name.toLowerCase()] || { owner: 'it', approval: false };
    const it = addCatalogItem({ kind: 'sharepoint', name: g.name, owner: r.owner, approval: r.approval, group_id: g.id });
    if (it) { added++; names.push(g.name); }
  }
  // Retire the legacy friendly-name rows (anything not SG-SP-*), so the form lists real groups only.
  let retired = 0;
  for (const c of catalogByKind('sharepoint')) {
    if (!/^sg-sp-/i.test(c.name)) { removeCatalogItem(c.id); retired++; }
  }
  return { added, retired, names };
}
