/**
 * Software-license seat sources (rent-the-pipes, simulation fallback).
 *
 * Six INDEPENDENT vendors, each its own adapter seam: Adobe, Bluebeam, AutoCAD (Autodesk),
 * HydraCAD, HFSS, and Microsoft 365. Each function is env-gated and returns null when unkeyed, so
 * the whole ingest degrades to the seeded seat inventory already in the database. Only the
 * shapes and the seams are wired here; the live vendor pulls are deliberately left as TODOs
 * (Bamboo is the one adapter wired for real, in bamboo.ts). A CSV / admin manual inventory
 * can populate license_seats via the same SeatRecord shape (source='manual').
 */

export type Vendor = 'adobe' | 'bluebeam' | 'autocad' | 'hydracad' | 'hfss' | 'microsoft';

export interface SeatRecord {
  vendor: Vendor;
  product: string;
  assignee_email: string | null;
  assignee_name: string | null;
  cost_monthly: number;
  assigned_at: string | null;
  source: string;
}

/* ── Microsoft 365 (Microsoft Graph: /subscribedSkus + /users assignedLicenses) ── */
export function microsoftConfigured(): boolean {
  // Either a static bearer token, or an Entra app-registration client-credentials trio.
  return !!(process.env.MS_GRAPH_TOKEN || (process.env.MS_GRAPH_TENANT && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET));
}

/** Default monthly list price per SKU part number; override with MS_SKU_COST_JSON (a JSON map). */
const MS_SKU_COST: Record<string, number> = {
  ENTERPRISEPACK: 36, // Microsoft 365 E3
  SPE_E3: 36,
  ENTERPRISEPREMIUM: 57, // E5
  SPE_E5: 57,
  O365_BUSINESS_PREMIUM: 22,
  O365_BUSINESS_ESSENTIALS: 6,
  SPB: 22, // Business Premium
  EXCHANGESTANDARD: 4,
  POWER_BI_PRO: 10,
  PROJECTPROFESSIONAL: 30,
  VISIOCLIENT: 15,
};
function skuCost(part: string): number {
  try {
    const override = process.env.MS_SKU_COST_JSON ? (JSON.parse(process.env.MS_SKU_COST_JSON) as Record<string, number>) : {};
    if (override[part] != null) return override[part];
  } catch { /* bad JSON → defaults */ }
  return MS_SKU_COST[part] != null ? MS_SKU_COST[part] : 20; // conservative fallback
}

/** Acquire a Graph bearer token: static token if given, else client-credentials against Entra. */
export async function graphToken(): Promise<string | null> {
  if (process.env.MS_GRAPH_TOKEN) return process.env.MS_GRAPH_TOKEN as string;
  const tenant = process.env.MS_GRAPH_TENANT as string;
  const body = new URLSearchParams({
    client_id: process.env.MS_GRAPH_CLIENT_ID as string,
    client_secret: process.env.MS_GRAPH_CLIENT_SECRET as string,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`graph token ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { access_token?: string };
  return j.access_token || null;
}

async function graphGet(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`graph ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchMicrosoftSeats(): Promise<SeatRecord[] | null> {
  if (!microsoftConfigured()) return null; // -> seeded inventory
  try {
    const token = await graphToken();
    if (!token) return null;

    // skuId → skuPartNumber, so each assigned license maps to a friendly product + a cost.
    const skus = (await graphGet('https://graph.microsoft.com/v1.0/subscribedSkus', token)) as { value?: any[] };
    const skuById = new Map<string, string>();
    for (const s of skus.value || []) if (s.skuId) skuById.set(s.skuId, s.skuPartNumber || s.skuId);

    // page through all users, one seat per assigned license
    const out: SeatRecord[] = [];
    let url: string | null = 'https://graph.microsoft.com/v1.0/users?$select=displayName,userPrincipalName,assignedLicenses&$top=999';
    while (url) {
      const page: { value?: any[]; '@odata.nextLink'?: string } = await graphGet(url, token);
      for (const u of page.value || []) {
        for (const lic of u.assignedLicenses || []) {
          const part = skuById.get(lic.skuId) || lic.skuId || 'Microsoft 365';
          out.push({
            vendor: 'microsoft',
            product: part,
            assignee_email: u.userPrincipalName ? String(u.userPrincipalName).toLowerCase() : null,
            assignee_name: u.displayName || u.userPrincipalName || null,
            cost_monthly: skuCost(part),
            assigned_at: null,
            source: 'graph',
          });
        }
      }
      url = page['@odata.nextLink'] || null;
    }
    return out;
  } catch (err) {
    console.warn('[licenses] microsoft graph pull failed, degrading to seed:', (err as Error).message);
    return null;
  }
}

/* ── Adobe (Adobe User Management API - UMAPI) ── */
export function adobeConfigured(): boolean {
  return !!process.env.ADOBE_UMAPI_TOKEN;
}
export async function fetchAdobeSeats(): Promise<SeatRecord[] | null> {
  if (!adobeConfigured()) return null;
  // TODO: Adobe UMAPI - list users + product profiles to map Creative Cloud seats to people.
  return [];
}

/* ── AutoCAD (Autodesk Platform Services / Account admin API) ── */
export function autodeskConfigured(): boolean {
  return !!process.env.AUTODESK_TOKEN;
}
export async function fetchAutocadSeats(): Promise<SeatRecord[] | null> {
  if (!autodeskConfigured()) return null;
  // TODO: Autodesk account API - list assigned users per subscription/seat.
  return [];
}

/* ── Bluebeam (Revu / Studio admin - separate product from HydraCAD) ── */
export function bluebeamConfigured(): boolean {
  return !!process.env.BLUEBEAM_API_KEY;
}
export async function fetchBluebeamSeats(): Promise<SeatRecord[] | null> {
  if (!bluebeamConfigured()) return null;
  // TODO: Bluebeam subscription admin - list seat assignments.
  return [];
}

/* ── HydraCAD (Hydratec sprinkler-hydraulic design - separate product from Bluebeam) ── */
export function hydracadConfigured(): boolean {
  return !!process.env.HYDRACAD_API_KEY;
}
export async function fetchHydracadSeats(): Promise<SeatRecord[] | null> {
  if (!hydracadConfigured()) return null;
  // TODO: HydraCAD license roster (vendor has no public API today; a manual/CSV inventory
  //       feeds these seats via source='manual' until then).
  return [];
}

/* ── HFSS (sprinkler hydraulic-calc license - separate product) ── */
export function hfssConfigured(): boolean {
  return !!process.env.HFSS_API_KEY;
}
export async function fetchHfssSeats(): Promise<SeatRecord[] | null> {
  if (!hfssConfigured()) return null;
  // TODO: HFSS license roster (vendor has no public API today; a manual/CSV inventory
  //       feeds these seats via source='manual' until then).
  return [];
}

/** Which of the six vendor adapters currently have a key present. */
export function configuredVendors(): Vendor[] {
  const out: Vendor[] = [];
  if (adobeConfigured()) out.push('adobe');
  if (bluebeamConfigured()) out.push('bluebeam');
  if (autodeskConfigured()) out.push('autocad');
  if (hydracadConfigured()) out.push('hydracad');
  if (hfssConfigured()) out.push('hfss');
  if (microsoftConfigured()) out.push('microsoft');
  return out;
}

/**
 * Pull seats from every keyed vendor adapter. Unkeyed adapters return null and are skipped,
 * so with zero keys this returns [] and the reconciliation runs on the seeded inventory.
 * Never throws; a failing adapter degrades to skipped.
 */
export async function fetchAllVendorSeats(): Promise<SeatRecord[]> {
  const adapters = [
    fetchMicrosoftSeats,
    fetchAdobeSeats,
    fetchAutocadSeats,
    fetchBluebeamSeats,
    fetchHydracadSeats,
    fetchHfssSeats,
  ];
  const out: SeatRecord[] = [];
  for (const a of adapters) {
    try {
      const rows = await a();
      if (rows) out.push(...rows);
    } catch (err) {
      console.warn('[licenses] vendor adapter failed, skipping:', (err as Error).message);
    }
  }
  return out;
}
