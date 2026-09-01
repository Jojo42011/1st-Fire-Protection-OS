import { getDb } from '../db/index';
import { stGet, stConfigured } from './servicetrade';
import { addSoftwareApp, importSoftwareCsv, SoftwareApp, SoftwareImportResult } from './softwareLicenses';

/**
 * Pull ServiceTrade users live (via the app's existing ServiceTrade REST connection) and record who
 * has ServiceTrade access, using the same software-license model as the PDF/CSV imports. ServiceTrade
 * is treated as an "app" so it appears on each person's access view alongside Adobe/Bluebeam/etc.
 * Read-only: only a GET is made, which is allowed even in ServiceTrade read-only mode.
 */

function serviceTradeApp(): SoftwareApp {
  const db = getDb();
  let app = db.prepare(`SELECT * FROM software_apps WHERE lower(name) = 'servicetrade'`).get() as SoftwareApp | undefined;
  if (!app) app = addSoftwareApp({ name: 'ServiceTrade', vendor: 'ServiceTrade', has_api: true }) || undefined;
  return app as SoftwareApp;
}

const csvq = (s: string) => `"${String(s || '').replace(/"/g, '""')}"`;

/** Normalize the many shapes a ServiceTrade list response can take into an array of users. */
function usersFrom(resp: any): any[] {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  const d = resp.data ?? resp;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.users)) return d.users;
  if (Array.isArray(resp.users)) return resp.users;
  return [];
}

export async function pullServiceTradeUsers(commit: boolean): Promise<{ ok: boolean; error?: string; fetched?: number; result?: SoftwareImportResult }> {
  if (!stConfigured()) return { ok: false, error: 'ServiceTrade is not connected (no credentials configured on the server).' };
  const app = serviceTradeApp();
  if (!app) return { ok: false, error: 'could not create the ServiceTrade app record' };

  let users: any[] = [];
  try {
    // /user is the ServiceTrade users endpoint; pull a generous page. Handle pagination if present.
    const first: any = await stGet('/user?limit=1000');
    users = usersFrom(first);
    const totalPages = Number(first?.data?.totalPages || first?.totalPages || 1);
    for (let p = 2; p <= totalPages && p <= 20; p++) {
      // eslint-disable-next-line no-await-in-loop
      const page: any = await stGet(`/user?limit=1000&page=${p}`);
      users = users.concat(usersFrom(page));
    }
  } catch (e) {
    return { ok: false, error: `ServiceTrade user fetch failed: ${(e as Error).message}` };
  }

  // Keep active users where we can tell; build a CSV the importer already understands.
  const lines = ['email,name'];
  let kept = 0;
  for (const u of users) {
    const status = String(u?.status || '').toLowerCase();
    if (status && /disabled|inactive|deleted|terminated/.test(status)) continue;
    const email = String(u?.email || u?.username || '').trim();
    const name = String(u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || '').trim();
    if (!email && !name) continue;
    lines.push(`${csvq(email)},${csvq(name)}`);
    kept++;
  }
  if (kept === 0) return { ok: false, error: `ServiceTrade returned ${users.length} record(s) but none had a usable email or name.`, fetched: users.length };

  const result = importSoftwareCsv(app.id, lines.join('\n'), commit);
  return { ok: result.ok, error: result.error, fetched: users.length, result };
}
