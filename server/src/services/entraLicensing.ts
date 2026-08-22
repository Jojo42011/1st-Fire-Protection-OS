import { getDb } from '../db/index';
import { graphToken } from './licenseSources';
import { graphUsersConfigured } from './msGraphUsers';

/**
 * Entra license assignment, cloud-side, after Azure AD Connect sync.
 *
 * A new hire's account is born on-prem and does not exist in Entra until the next sync, so we cannot
 * assign a license the instant the account is created. Instead the OS queues the assignment (upn +
 * SKU) and retries over Graph every few minutes: once the synced user appears in Entra, it sets the
 * usage location (required for licensing) and assigns the SKU, then marks the onboarding item done.
 * Keyless- and permission-safe: a missing Graph credential is a graceful no-op, not a throw.
 *
 * Graph application permissions required: User.ReadWrite.All (assign) and Organization.Read.All (read
 * subscribedSkus), granted with admin consent.
 */

const MAX_AGE_HOURS = 72; // stop retrying (mark expired) if the user never syncs within this window
const GRAPH = 'https://graph.microsoft.com/v1.0';
const isGuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export interface LicenseQueueRow {
  id: number; upn: string; sku_part: string; sku_id: string | null; usage_location: string;
  ref_type: string | null; ref_id: number | null; status: string; attempts: number; last_error: string | null;
}

/** Queue a license assignment for a hire. No-op if no SKU is given. */
export function enqueueLicense(upn: string, skuPart: string, ref: { type: string; id: number } | null, usageLocation = 'US'): { id: number } | null {
  if (!upn || !skuPart) return null;
  const db = getDb();
  // Avoid duplicate open rows for the same upn+sku.
  const existing = db.prepare(`SELECT id FROM entra_license_queue WHERE lower(upn) = lower(?) AND sku_part = ? AND status IN ('pending','assigned')`).get(upn, skuPart) as { id: number } | undefined;
  if (existing) return { id: existing.id };
  const info = db.prepare(
    `INSERT INTO entra_license_queue (upn, sku_part, usage_location, ref_type, ref_id) VALUES (?,?,?,?,?)`
  ).run(upn, skuPart, usageLocation || 'US', ref ? ref.type : null, ref ? ref.id : null);
  return { id: Number(info.lastInsertRowid) };
}

async function graphGet(token: string, url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** Find the synced user in Entra by UPN. status 404 => not synced yet. */
async function findUser(token: string, upn: string): Promise<{ found: boolean; id?: string; usageLocation?: string | null; skuIds?: string[]; error?: string }> {
  const { status, json } = await graphGet(token, `${GRAPH}/users/${encodeURIComponent(upn)}?$select=id,usageLocation,assignedLicenses`);
  if (status === 404) return { found: false };
  if (status === 401 || status === 403) return { found: false, error: 'Graph access denied: grant User.ReadWrite.All with admin consent.' };
  if (status >= 400) return { found: false, error: `graph user ${status}` };
  return { found: true, id: json.id, usageLocation: json.usageLocation || null, skuIds: Array.isArray(json.assignedLicenses) ? json.assignedLicenses.map((l: any) => l.skuId) : [] };
}

/** Resolve a SKU part number to its tenant skuId (and whether a seat is free). A GUID passes through. */
async function resolveSku(token: string, skuPart: string): Promise<{ skuId?: string; available?: boolean; error?: string }> {
  if (isGuid(skuPart)) return { skuId: skuPart, available: true };
  const { status, json } = await graphGet(token, `${GRAPH}/subscribedSkus?$select=skuId,skuPartNumber,prepaidUnits,consumedUnits`);
  if (status >= 400) return { error: `subscribedSkus ${status} (needs Organization.Read.All)` };
  const hit = (json.value || []).find((s: any) => String(s.skuPartNumber).toLowerCase() === skuPart.toLowerCase());
  if (!hit) return { error: `tenant has no SKU "${skuPart}"` };
  const enabled = hit.prepaidUnits && typeof hit.prepaidUnits.enabled === 'number' ? hit.prepaidUnits.enabled : 0;
  return { skuId: hit.skuId, available: enabled > (hit.consumedUnits || 0) };
}

async function patchUsageLocation(token: string, id: string, loc: string): Promise<boolean> {
  const res = await fetch(`${GRAPH}/users/${id}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ usageLocation: loc }) });
  return res.ok;
}

async function assignLicense(token: string, id: string, skuId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${GRAPH}/users/${id}/assignLicense`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ addLicenses: [{ skuId, disabledPlans: [] }], removeLicenses: [] }),
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => '');
  return { ok: false, error: `assignLicense ${res.status}: ${text.slice(0, 160)}` };
}

/** Try to assign one queued license now. Returns the new status for the row. */
async function processOne(token: string, row: LicenseQueueRow): Promise<{ status: 'pending' | 'assigned' | 'error'; error?: string; skuId?: string }> {
  const user = await findUser(token, row.upn);
  if (user.error) return { status: 'pending', error: user.error };
  if (!user.found) return { status: 'pending', error: 'waiting for AD Connect sync' };

  const sku = await resolveSku(token, row.sku_part);
  if (!sku.skuId) return { status: 'error', error: sku.error || 'could not resolve SKU' };
  if ((user.skuIds || []).includes(sku.skuId)) return { status: 'assigned', skuId: sku.skuId }; // already licensed

  if (!user.usageLocation) {
    const ok = await patchUsageLocation(token, user.id!, row.usage_location || 'US');
    if (!ok) return { status: 'pending', error: 'could not set usageLocation yet' };
  }
  const res = await assignLicense(token, user.id!, sku.skuId);
  if (!res.ok) {
    if (sku.available === false) return { status: 'error', error: `no free seat for ${row.sku_part}` };
    return { status: 'error', error: res.error };
  }
  return { status: 'assigned', skuId: sku.skuId };
}

/** Process the pending license queue: one Graph pass over pending rows. Called on a timer. */
export async function processLicenseQueue(): Promise<{ assigned: number; pending: number; error: number }> {
  const db = getDb();
  const out = { assigned: 0, pending: 0, error: 0 };
  if (!graphUsersConfigured()) return out;
  const rows = db.prepare(`SELECT * FROM entra_license_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 50`).all() as LicenseQueueRow[];
  if (!rows.length) return out;
  const token = await graphToken();
  if (!token) return out;

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const r = await processOne(token, row);
    if (r.status === 'assigned') {
      db.prepare(`UPDATE entra_license_queue SET status = 'assigned', sku_id = ?, last_error = NULL, assigned_at = datetime('now'), updated_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`).run(r.skuId || null, row.id);
      out.assigned++;
      markLicenseItemDone(row);
    } else if (r.status === 'error') {
      db.prepare(`UPDATE entra_license_queue SET status = 'error', last_error = ?, updated_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`).run(r.error || 'error', row.id);
      out.error++;
    } else {
      // still pending: expire if too old, else record the reason and keep retrying.
      const aged = db.prepare(`SELECT (julianday('now') - julianday(created_at)) * 24 AS hrs FROM entra_license_queue WHERE id = ?`).get(row.id) as { hrs: number };
      if (aged && aged.hrs > MAX_AGE_HOURS) {
        db.prepare(`UPDATE entra_license_queue SET status = 'expired', last_error = ?, updated_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`).run(r.error || 'never synced', row.id);
        out.error++;
      } else {
        db.prepare(`UPDATE entra_license_queue SET last_error = ?, updated_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`).run(r.error || 'pending', row.id);
        out.pending++;
      }
    }
  }
  return out;
}

/** When a license lands, mark the onboarding license/email item done so the board reflects it. */
function markLicenseItemDone(row: LicenseQueueRow): void {
  if (row.ref_type !== 'onboarding_request' || !row.ref_id) return;
  const db = getDb();
  db.prepare(`UPDATE onboarding_items SET status = 'done', decided_by = 'entra-license', decided_at = datetime('now')
              WHERE request_id = ? AND owner = 'it' AND kind = 'task' AND status = 'pending' AND label = 'Set up company email'`).run(row.ref_id);
}

/** The latest license-queue row for a ref, for the onboarding UI. */
export function licenseStatusForRef(refType: string, refId: number): { status: string; sku_part: string; last_error: string | null } | null {
  const r = getDb().prepare(`SELECT status, sku_part, last_error FROM entra_license_queue WHERE ref_type = ? AND ref_id = ? ORDER BY id DESC LIMIT 1`).get(refType, refId) as any;
  return r || null;
}
