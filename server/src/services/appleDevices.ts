/**
 * Apple device mirror: Apple Business Manager (what the company owns, and which MDM each device is
 * assigned to) and Addigy (what is actually enrolled and checking in). Both are read-only pulls into
 * apple_devices, keyed by serial. The Devices page joins them to AT&T lines by serial and IMEI.
 *
 *   Addigy:  ADDIGY_API_KEY (Account > Integrations > API & Webhooks > V2, permission "View Devices").
 *            POST https://api.addigy.com/api/v2/devices with the key in the x-api-key header.
 *   ABM:     ABM_CLIENT_ID (BUSINESSAPI.<uuid>), ABM_KEY_ID, ABM_PRIVATE_KEY (the downloaded .pem, EC P-256),
 *            optional ABM_TEAM_ID (defaults to the client id). A short-lived ES256 client assertion is
 *            exchanged at account.apple.com for a one-hour token, then /v1/orgDevices is paged.
 * Unkeyed = a logged no-op, never a crash.
 */
import crypto from 'crypto';
import { getDb } from '../db/index';
import { setState } from '../db/schema';

const ADDIGY = 'https://api.addigy.com/api/v2';
const ABM_TOKEN_URL = 'https://account.apple.com/auth/oauth2/token';
const ABM_AUDIENCE = 'https://account.apple.com/auth/oauth2/v2/token';
const ABM_API = 'https://api-business.apple.com';

export const addigyConfigured = (): boolean => !!process.env.ADDIGY_API_KEY;
export const abmConfigured = (): boolean => !!(process.env.ABM_CLIENT_ID && process.env.ABM_KEY_ID && process.env.ABM_PRIVATE_KEY);

/* ─────────────────────────── Addigy ─────────────────────────── */

/** Read a fact by its exact identifier, or the first fact whose identifier matches the pattern. */
function fact(facts: Record<string, any>, exact: string[], pattern?: RegExp): any {
  for (const k of exact) if (facts[k] && facts[k].value != null && facts[k].value !== '') return facts[k].value;
  if (pattern) for (const k of Object.keys(facts)) if (pattern.test(k) && facts[k] && facts[k].value != null && facts[k].value !== '') return facts[k].value;
  return null;
}

export interface AddigyDevice { serial: string; name: string | null; model: string | null; imei: string | null; user: string | null; lastOnline: string | null; os: string | null; supervised: number | null; agentId: string | null }

export function mapAddigyItem(item: any): AddigyDevice | null {
  const f = (item && item.facts) || {};
  const serial = String(fact(f, ['serial_number', 'device_serial_number'], /serial/) || '').trim().toUpperCase();
  if (!serial) return null;
  const imeiRaw = fact(f, ['imei', 'mdm_imei'], /imei/);
  const sup = fact(f, ['is_supervised', 'supervised', 'mdm_is_supervised'], /supervis/);
  return {
    serial,
    name: fact(f, ['device_name']) ?? null,
    model: fact(f, ['device_model_name', 'hardware_model']) ?? null,
    imei: imeiRaw ? String(Array.isArray(imeiRaw) ? imeiRaw[0] : imeiRaw).replace(/\D/g, '') || null : null,
    user: fact(f, ['assigned_user', 'user_email', 'current_user'], /user.*(email|name)|assigned_user/) ?? null,
    lastOnline: fact(f, ['last_online', 'last_online_at', 'mdm_last_connected'], /last_(online|connected|check)/) ?? item.agent_audit_date ?? item.audit_date ?? null,
    os: fact(f, ['os_version', 'mdm_os_version', 'os_platform_version'], /os_version/) ?? null,
    supervised: sup == null ? null : /^(true|1|yes)$/i.test(String(sup)) ? 1 : 0,
    agentId: item.agentid || null,
  };
}

export async function syncAddigy(): Promise<{ ok: boolean; message: string; devices?: number }> {
  if (!addigyConfigured()) return { ok: false, message: 'not connected (set ADDIGY_API_KEY)' };
  const devices: AddigyDevice[] = [];
  try {
    let page = 1, pages = 1;
    while (page <= pages && page <= 60) {
      const res = await fetch(`${ADDIGY}/devices`, {
        method: 'POST',
        headers: { 'x-api-key': String(process.env.ADDIGY_API_KEY), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ page, per_page: 100, query: { filters: [] } }),
        redirect: 'follow',
      });
      if (!res.ok) {
        const t = (await res.text().catch(() => '')).slice(0, 200);
        return { ok: false, message: res.status === 401 || res.status === 403 ? 'Addigy refused the key. Make sure it is a V2 token with the View Devices permission.' : `Addigy ${res.status}: ${t}` };
      }
      const j: any = await res.json();
      for (const it of j.items || []) { const d = mapAddigyItem(it); if (d) devices.push(d); }
      pages = Number(j.metadata?.page_count) || 1;
      page++;
    }
  } catch (err) {
    return { ok: false, message: `Addigy request failed: ${(err as Error).message.slice(0, 200)}` };
  }
  const db = getDb();
  const now = new Date().toISOString();
  const up = db.prepare(`INSERT INTO apple_devices (serial, imei, model, in_addigy, addigy_agent_id, addigy_device_name, addigy_user, addigy_last_online, addigy_os, addigy_supervised, addigy_synced_at, updated_at)
    VALUES (@serial, @imei, @model, 1, @agentId, @name, @user, @lastOnline, @os, @supervised, @now, @now)
    ON CONFLICT(serial) DO UPDATE SET imei = COALESCE(excluded.imei, apple_devices.imei), model = COALESCE(apple_devices.model, excluded.model), in_addigy = 1,
      addigy_agent_id = excluded.addigy_agent_id, addigy_device_name = excluded.addigy_device_name, addigy_user = excluded.addigy_user,
      addigy_last_online = excluded.addigy_last_online, addigy_os = excluded.addigy_os, addigy_supervised = excluded.addigy_supervised,
      addigy_synced_at = excluded.addigy_synced_at, updated_at = excluded.updated_at`);
  db.transaction(() => {
    db.prepare(`UPDATE apple_devices SET in_addigy = 0`).run();
    for (const d of devices) up.run({ ...d, now });
  })();
  setState('mobile.addigy_synced_at', now);
  return { ok: true, message: `${devices.length} device(s) in Addigy`, devices: devices.length };
}

/* ─────────────────────────── Apple Business Manager ─────────────────────────── */

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** The ES256 client assertion Apple exchanges for an access token. Exported for tests. */
export function abmClientAssertion(opts: { clientId: string; keyId: string; teamId?: string; privateKeyPem: string; now?: number }): string {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = { alg: 'ES256', kid: opts.keyId, typ: 'JWT' };
  const payload = { iss: opts.teamId || opts.clientId, sub: opts.clientId, aud: ABM_AUDIENCE, iat: now - 30, exp: now + 600, jti: crypto.randomUUID() };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: opts.privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

let abmCache: { token: string; exp: number } | null = null;
async function abmToken(): Promise<string> {
  if (abmCache && abmCache.exp > Date.now() + 60_000) return abmCache.token;
  const clientId = String(process.env.ABM_CLIENT_ID);
  const assertion = abmClientAssertion({
    clientId, keyId: String(process.env.ABM_KEY_ID), teamId: process.env.ABM_TEAM_ID || undefined,
    privateKeyPem: String(process.env.ABM_PRIVATE_KEY).replace(/\\n/g, '\n'),
  });
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: clientId, scope: 'business.api',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion,
  });
  const res = await fetch(ABM_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  if (!res.ok) throw new Error(`Apple token ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j: any = await res.json();
  abmCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return abmCache.token;
}
/** Page a JSON:API list, following links.next only while it stays on Apple's API host. */
async function abmList(path: string, token: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = `${ABM_API}${path}`, guard = 0;
  while (next && guard++ < 100) {
    if (!next.startsWith(ABM_API)) break;
    const res: Response = await fetch(next, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`Apple ${res.status} on ${path}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const j: any = await res.json();
    out.push(...(j.data || []));
    next = j.links?.next || null;
  }
  return out;
}
const first = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return x == null || x === '' ? null : String(x);
};

export async function syncAbm(): Promise<{ ok: boolean; message: string; devices?: number }> {
  if (!abmConfigured()) return { ok: false, message: 'not connected (set ABM_CLIENT_ID, ABM_KEY_ID, ABM_PRIVATE_KEY)' };
  let devices: any[] = [];
  const serverOf = new Map<string, string>();
  try {
    const token = await abmToken();
    devices = await abmList('/v1/orgDevices?limit=1000', token);
    // Which MDM server each device is assigned to (Addigy, once it is set up in ABM).
    for (const s of await abmList('/v1/mdmServers?limit=100', token)) {
      const name = s.attributes?.serverName || s.id;
      for (const d of await abmList(`/v1/mdmServers/${encodeURIComponent(s.id)}/relationships/devices?limit=1000`, token)) serverOf.set(String(d.id).toUpperCase(), name);
    }
  } catch (err) {
    abmCache = null;
    return { ok: false, message: (err as Error).message.slice(0, 300) };
  }
  const db = getDb();
  const now = new Date().toISOString();
  const up = db.prepare(`INSERT INTO apple_devices (serial, imei, model, product_family, in_abm, abm_status, abm_server, abm_added_at, abm_released_at, abm_purchase_source, abm_order_number, abm_synced_at, updated_at)
    VALUES (@serial, @imei, @model, @family, 1, @status, @server, @added, @released, @source, @order, @now, @now)
    ON CONFLICT(serial) DO UPDATE SET imei = COALESCE(excluded.imei, apple_devices.imei), model = COALESCE(excluded.model, apple_devices.model),
      product_family = excluded.product_family, in_abm = 1, abm_status = excluded.abm_status, abm_server = excluded.abm_server,
      abm_added_at = excluded.abm_added_at, abm_released_at = excluded.abm_released_at, abm_purchase_source = excluded.abm_purchase_source,
      abm_order_number = excluded.abm_order_number, abm_synced_at = excluded.abm_synced_at, updated_at = excluded.updated_at`);
  let n = 0;
  db.transaction(() => {
    db.prepare(`UPDATE apple_devices SET in_abm = 0`).run();
    for (const d of devices) {
      const a = d.attributes || {};
      const serial = String(a.serialNumber || d.id || '').toUpperCase();
      if (!serial || a.releasedFromOrgDateTime) continue; // released devices are no longer the company's
      up.run({
        serial, imei: (first(a.imei) || '').replace(/\D/g, '') || null, model: a.deviceModel || null, family: a.productFamily || null,
        status: a.status || null, server: serverOf.get(serial) || null, added: a.addedToOrgDateTime || null, released: a.releasedFromOrgDateTime || null,
        source: a.purchaseSourceType || null, order: a.orderNumber || null, now,
      });
      n++;
    }
  })();
  setState('mobile.abm_synced_at', now);
  return { ok: true, message: `${n} device(s) in Apple Business Manager`, devices: n };
}
