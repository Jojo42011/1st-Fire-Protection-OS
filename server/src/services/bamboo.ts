/**
 * BambooHR adapter (rent-the-pipes, simulation fallback).
 *
 * When BAMBOO_SUBDOMAIN + BAMBOO_API_KEY are present, fetchDirectory() pulls the live
 * employee directory from the BambooHR REST API. When they are not, it returns null and
 * the caller degrades to the seeded roster already in the database, exactly like the other
 * integrations. Never throws on a missing key or a transient network error; a failed live
 * pull degrades to null so the OS keeps running on what it already knows.
 *
 * Auth: BambooHR uses HTTP Basic auth with the API key as the username and any value as the
 * password (their convention is "x").
 */

export interface DirectoryEmployee {
  full_name: string;
  email: string | null;
  department: string | null;
  title: string | null;
  status: 'active' | 'terminated';
  hired_at: string | null;
  terminated_at: string | null;
  source: 'bamboo';
}

/** A roster row that carries the employee's office/location (for location-scoped listings). */
export interface RosterEmployee {
  full_name: string;
  email: string | null;
  department: string | null;
  title: string | null;
  location: string | null;
  status: 'active' | 'terminated';
  hired_at: string | null;
  source: 'bamboo';
}

export function bambooConfigured(): boolean {
  return !!(process.env.BAMBOO_SUBDOMAIN && process.env.BAMBOO_API_KEY);
}

/** Basic auth header for BambooHR (apiKey as username, "x" as password). */
function authHeader(): string {
  const key = process.env.BAMBOO_API_KEY as string;
  return 'Basic ' + Buffer.from(`${key}:x`).toString('base64');
}

/**
 * Pull the employee directory. Returns null when unkeyed (simulation fallback) so the caller
 * keeps the seeded roster. The BambooHR directory endpoint returns ACTIVE employees; every row
 * here is therefore marked 'active'. Terminated employees are read separately via
 * fetchTerminated() (the reports API), so the reconciliation still sees who has left.
 */
export async function fetchDirectory(): Promise<DirectoryEmployee[] | null> {
  if (!bambooConfigured()) return null; // -> caller uses the seeded roster
  const sub = process.env.BAMBOO_SUBDOMAIN as string;
  const url = `https://api.bamboohr.com/api/gateway.php/${encodeURIComponent(sub)}/v1/employees/directory`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: authHeader(), accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`bamboo ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { employees?: any[] };
    const rows = Array.isArray(data.employees) ? data.employees : [];
    return rows.map((e) => ({
      full_name:
        e.displayName ||
        [e.firstName, e.lastName].filter(Boolean).join(' ') ||
        String(e.id || 'Unknown'),
      email: e.workEmail || e.bestEmail || null,
      department: e.department || null,
      title: e.jobTitle || null,
      status: 'active' as const,
      hired_at: e.hireDate || null,
      terminated_at: null,
      source: 'bamboo' as const,
    }));
  } catch (err) {
    console.warn('[bamboo] directory pull failed, degrading to seed:', (err as Error).message);
    return null;
  }
}

/**
 * Read employment status for the reconciliation. The active directory above is the primary
 * signal (anyone NOT on it is treated as gone). A fuller build reads terminated employees and
 * their separation dates from a BambooHR custom report:
 *   POST /v1/reports/custom  { fields:["status","terminationDate", ...], filters:{...} }
 * TODO: wire the custom-report pull so terminated rows carry their real terminated_at date.
 * Until then this returns [] and the reconciliation relies on "not on the active roster".
 */
export async function fetchTerminated(): Promise<DirectoryEmployee[]> {
  if (!bambooConfigured()) return [];
  const sub = process.env.BAMBOO_SUBDOMAIN as string;
  const url = `https://api.bamboohr.com/api/gateway.php/${encodeURIComponent(sub)}/v1/reports/custom?format=JSON&onlyCurrent=false`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: authHeader(), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Terminated roster (license reconciliation)',
        fields: ['displayName', 'firstName', 'lastName', 'workEmail', 'department', 'jobTitle', 'status', 'terminationDate', 'hireDate'],
      }),
    });
    if (!res.ok) throw new Error(`bamboo report ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { employees?: any[] };
    const rows = Array.isArray(data.employees) ? data.employees : [];
    // BambooHR marks former employees status='Inactive' (not 'Terminated'), and returns a
    // placeholder terminationDate of '0000-00-00' for ACTIVE staff — so filter on status, not
    // on the presence of a date, and null out the placeholder.
    const cleanDate = (d: string | null | undefined): string | null => (d && d !== '0000-00-00' ? d : null);
    return rows
      .filter((e) => {
        const s = String(e.status || '').toLowerCase();
        return s === 'inactive' || s === 'terminated';
      })
      .map((e) => ({
        full_name: e.displayName || [e.firstName, e.lastName].filter(Boolean).join(' ') || String(e.id || 'Unknown'),
        email: e.workEmail || null,
        department: e.department || null,
        title: e.jobTitle || null,
        status: 'terminated' as const,
        hired_at: cleanDate(e.hireDate),
        terminated_at: cleanDate(e.terminationDate),
        source: 'bamboo' as const,
      }));
  } catch (err) {
    console.warn('[bamboo] terminated report failed, degrading:', (err as Error).message);
    return [];
  }
}

/**
 * Pull the full roster WITH each employee's office/location, so callers can list people by
 * location (the directory endpoint above intentionally omits location). Uses the custom-report
 * API — the authoritative source for the `location` field regardless of directory settings.
 *
 * `onlyCurrent` defaults to true (active employees only). Returns null when unkeyed so the caller
 * can degrade gracefully; never throws on a transient failure.
 */
export async function fetchRoster(opts: { onlyCurrent?: boolean } = {}): Promise<RosterEmployee[] | null> {
  if (!bambooConfigured()) return null;
  const sub = process.env.BAMBOO_SUBDOMAIN as string;
  const onlyCurrent = opts.onlyCurrent !== false; // active-only by default
  const url = `https://api.bamboohr.com/api/gateway.php/${encodeURIComponent(sub)}/v1/reports/custom?format=JSON&onlyCurrent=${onlyCurrent ? 'true' : 'false'}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: authHeader(), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Roster by location',
        fields: ['displayName', 'firstName', 'lastName', 'workEmail', 'department', 'jobTitle', 'location', 'status', 'hireDate'],
      }),
    });
    if (!res.ok) throw new Error(`bamboo roster ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { employees?: any[] };
    const rows = Array.isArray(data.employees) ? data.employees : [];
    return rows.map((e) => {
      const s = String(e.status || '').toLowerCase();
      return {
        full_name: e.displayName || [e.firstName, e.lastName].filter(Boolean).join(' ') || String(e.id || 'Unknown'),
        email: e.workEmail || null,
        department: e.department || null,
        title: e.jobTitle || null,
        location: e.location || null,
        status: (s === 'inactive' || s === 'terminated' ? 'terminated' : 'active') as 'active' | 'terminated',
        hired_at: e.hireDate && e.hireDate !== '0000-00-00' ? e.hireDate : null,
        source: 'bamboo' as const,
      };
    });
  } catch (err) {
    console.warn('[bamboo] roster pull failed, degrading:', (err as Error).message);
    return null;
  }
}
