/**
 * The editable onboarding form catalog: the computers, software, SharePoint groups, and printers the
 * onboarding form offers. These are company-specific and change over time, so they live in the
 * database and a People admin edits them, rather than being hardcoded. The onboarding router reads
 * its routing (which team an item goes to, and whether it needs approval) from the same rows.
 */
import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { operatingOffices } from '../os/office';

export type CatalogKind = 'computer' | 'software' | 'sharepoint' | 'printer';
export interface CatalogItem {
  id: number;
  kind: CatalogKind;
  name: string;
  spec: string | null;
  owner: string;
  approval: boolean;
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
    sort: r.sort ?? 0,
    active: r.active === 1,
  };
}

/** All active items of one kind, in sort order. */
export function catalogByKind(kind: CatalogKind): CatalogItem[] {
  return (getDb().prepare(`SELECT * FROM onboarding_catalog WHERE kind = ? AND active = 1 ORDER BY sort, id`).all(kind) as any[]).map(toItem);
}

/** Every active item, grouped by kind (for the editor and the form option catalogs). */
export function catalogAll(): Record<CatalogKind, CatalogItem[]> {
  return {
    computer: catalogByKind('computer'),
    software: catalogByKind('software'),
    sharepoint: catalogByKind('sharepoint'),
    printer: catalogByKind('printer'),
  };
}

const KINDS: CatalogKind[] = ['computer', 'software', 'sharepoint', 'printer'];

/** Add an item. Returns the created row, or null if the kind/name is invalid. */
export function addCatalogItem(input: { kind: string; name: string; spec?: string; owner?: string; approval?: boolean }): CatalogItem | null {
  const kind = input.kind as CatalogKind;
  const name = (input.name || '').trim();
  if (!KINDS.includes(kind) || !name) return null;
  const db = getDb();
  const maxSort = (db.prepare(`SELECT COALESCE(MAX(sort), -1) AS m FROM onboarding_catalog WHERE kind = ?`).get(kind) as { m: number }).m;
  const info = db
    .prepare(`INSERT INTO onboarding_catalog (kind, name, spec, owner, approval, sort) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(kind, name, input.spec ?? null, input.owner || 'it', input.approval ? 1 : 0, maxSort + 1);
  return toItem(db.prepare(`SELECT * FROM onboarding_catalog WHERE id = ?`).get(Number(info.lastInsertRowid)));
}

/** Edit an item's fields. Returns the updated row, or null if it does not exist. */
export function updateCatalogItem(id: number, patch: { name?: string; spec?: string; owner?: string; approval?: boolean }): CatalogItem | null {
  const db = getDb();
  const cur = db.prepare(`SELECT * FROM onboarding_catalog WHERE id = ?`).get(id) as any;
  if (!cur) return null;
  const name = patch.name != null ? patch.name.trim() || cur.name : cur.name;
  const spec = patch.spec !== undefined ? (patch.spec || null) : cur.spec;
  const owner = patch.owner != null ? patch.owner : cur.owner;
  const approval = patch.approval != null ? (patch.approval ? 1 : 0) : cur.approval;
  db.prepare(`UPDATE onboarding_catalog SET name = ?, spec = ?, owner = ?, approval = ? WHERE id = ?`).run(name, spec, owner, approval, id);
  return toItem(db.prepare(`SELECT * FROM onboarding_catalog WHERE id = ?`).get(id));
}

/** Soft-remove an item (kept for any in-flight references, hidden from the form). */
export function removeCatalogItem(id: number): boolean {
  return getDb().prepare(`UPDATE onboarding_catalog SET active = 0 WHERE id = ?`).run(id).changes > 0;
}
