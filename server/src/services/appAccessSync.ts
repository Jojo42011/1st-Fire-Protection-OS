import { getDb } from '../db/index';
import { stConfigured } from './servicetrade';
import { pullServiceTradeUsers } from './servicetradeUsers';
import { intacctConfigured, listSageUsers } from './sageIntacct';
import { importSoftwareCsv, SoftwareImportResult } from './softwareLicenses';
import { reconcileAppAccessItems } from './offboardingAgent';
import { autoCompleteServiceTradeSetup } from './onboardingAgent';

/**
 * Keep each person's app access (Software tab) current from the apps that have an API, then close any
 * open offboarding step for an app the person does not hold. Read-only against the vendors.
 */

const csvq = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;

/** Live Sage Intacct user list into the "Sage Intacct" app. A no-op when Sage is not connected. */
export async function pullSageUsers(commit: boolean): Promise<{ ok: boolean; error?: string; fetched?: number; result?: SoftwareImportResult }> {
  if (!intacctConfigured()) return { ok: false, error: 'Sage Intacct is not connected.' };
  const app = getDb().prepare(`SELECT id FROM software_apps WHERE lower(name) = 'sage intacct'`).get() as { id: number } | undefined;
  if (!app) return { ok: false, error: 'The Sage Intacct app record is missing.' };
  const res = await listSageUsers();
  if (!res.ok) return { ok: false, error: res.error };
  const lines = ['email,name,login id,user type'];
  for (const u of res.users) {
    if (u.status && !/^active$/i.test(u.status)) continue;
    if (!u.email && !u.name) continue;
    lines.push([u.email, u.name, u.loginId, u.type].map(csvq).join(','));
  }
  if (lines.length === 1) return { ok: false, error: `Sage returned ${res.users.length} user(s) but none were active with a name or email.`, fetched: res.users.length };
  const result = importSoftwareCsv(app.id, lines.join('\n'), commit, 'api');
  return { ok: result.ok, error: result.error, fetched: res.users.length, result };
}

export async function refreshAppAccess(): Promise<string> {
  const parts: string[] = [];
  if (stConfigured()) {
    const st = await pullServiceTradeUsers(true);
    parts.push(st.ok ? `ServiceTrade ${st.result?.matched ?? 0} users` : `ServiceTrade: ${st.error}`);
  }
  if (intacctConfigured()) {
    const sg = await pullSageUsers(true);
    parts.push(sg.ok ? `Sage Intacct ${sg.result?.matched ?? 0} users` : `Sage Intacct: ${sg.error}`);
  }
  const r = reconcileAppAccessItems();
  parts.push(`offboarding: ${r.na} step(s) N/A, ${r.done} already done`);
  const st = autoCompleteServiceTradeSetup();
  if (st) parts.push(`onboarding: ${st} ServiceTrade setup task(s) done`);
  return parts.join('; ');
}
