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
  return !!process.env.MS_GRAPH_TOKEN;
}
export async function fetchMicrosoftSeats(): Promise<SeatRecord[] | null> {
  if (!microsoftConfigured()) return null; // -> seeded inventory
  // TODO: Microsoft Graph - GET /subscribedSkus for the plan cost, GET /users?$select=
  //       assignedLicenses,userPrincipalName to map each E3/E5 seat to a person.
  return [];
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
