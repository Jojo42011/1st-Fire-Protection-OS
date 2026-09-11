import { fetchRosterForImport } from './bamboo';

/**
 * Phone-list export from BambooHR: First name, Last name, and the LAST 4 digits of the mobile phone.
 *
 * Pulls live from BambooHR (mobilePhone + location + status), so it never depends on the local mirror
 * carrying phone. Filterable to one or more legal entities / locations (e.g. "1st FP Services", "MGMT")
 * by a case-insensitive, punctuation-insensitive substring match on the BambooHR location. Keyless-safe:
 * returns { ok:false } instead of throwing when BambooHR is not connected.
 */

const digits = (s: string | null | undefined): string => (s || '').replace(/\D/g, '');
/** The last 4 digits of a phone number (all digits if fewer than 4, blank if none). */
export function last4(s: string | null | undefined): string {
  const d = digits(s);
  return d.length >= 4 ? d.slice(-4) : d;
}
const norm = (s: string | null | undefined): string => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export interface PhoneRow { first: string; last: string; last4: string; location: string | null; status: string | null; hasPhone: boolean }

export async function phoneListPull(): Promise<{ ok: boolean; error?: string; rows: PhoneRow[]; locations: { location: string; count: number }[] }> {
  const roster = await fetchRosterForImport();
  if (!roster) return { ok: false, error: 'BambooHR is not connected (set BAMBOO_SUBDOMAIN and BAMBOO_API_KEY).', rows: [], locations: [] };
  const rows: PhoneRow[] = roster.map((r) => ({
    first: r.firstName || r.preferredName || '',
    last: r.lastName || '',
    last4: last4(r.mobilePhone),
    location: r.location,
    status: r.status,
    hasPhone: !!digits(r.mobilePhone),
  }));
  const lm = new Map<string, number>();
  for (const r of roster) { const k = r.location || '(none)'; lm.set(k, (lm.get(k) || 0) + 1); }
  const locations = [...lm.entries()].map(([location, count]) => ({ location, count })).sort((a, b) => b.count - a.count);
  return { ok: true, rows, locations };
}

/** Keep only rows whose location matches one of the entities (substring, punctuation-insensitive) and,
 *  by default, whose status is Active. */
export function filterEntities(rows: PhoneRow[], entities: string[], activeOnly = true): PhoneRow[] {
  const needles = entities.map(norm).filter(Boolean);
  return rows.filter((r) => {
    if (activeOnly && r.status && r.status.trim().toLowerCase() !== 'active') return false;
    if (!needles.length) return true;
    const loc = norm(r.location);
    return needles.some((n) => loc.includes(n));
  });
}

const csvCell = (s: string | null | undefined): string => {
  const v = String(s == null ? '' : s);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};

/** The 3-column CSV the request asks for: First name, Last name, Last 4. */
export function toPhoneCsv(rows: PhoneRow[]): string {
  const lines = ['First name,Last name,Last 4'];
  for (const r of rows) lines.push([csvCell(r.first), csvCell(r.last), csvCell(r.last4)].join(','));
  return lines.join('\r\n');
}
