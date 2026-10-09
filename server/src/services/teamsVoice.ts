/**
 * Teams voice: who holds a Teams Phone / Calling Plan license and whether they actually make calls.
 *
 * Uses the shared Entra app (client credentials) the rest of the OS uses. It is a background sync,
 * so it needs APPLICATION permissions with admin consent (a delegated permission only works while a
 * person is signed in, and cannot run on a schedule):
 *   - User.Read.All + Organization.Read.All : users, their licenses and service plans (already granted)
 *   - Reports.Read.All                      : Teams user activity (Call Count, Meeting Count)
 *   - CallRecords.Read.PstnCalls (optional) : PSTN call detail, so "calls a real phone number" is known
 * Each step degrades on its own: a missing permission is reported, never thrown.
 */
import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { graphToken } from './licenseSources';
import { graphUsersConfigured } from './msGraphUsers';
import { graphGrantedRoles } from './msGraphOffboard';
import { parseCsv } from './rmmImport';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface TeamsVoiceStatus {
  at: string;
  ok: boolean;
  error?: string;
  users: number;
  voiceUsers: number;
  usage: boolean;
  pstn: boolean;
  concealed: boolean;
  gaps: string[];
  period: string;
}

/** Service plans that mean "this person has Teams voice". MCOEV = Teams Phone, MCOPSTN* = Calling Plans.
 *  MCOEV_VIRTUALUSER is a resource account (auto attendant, call queue), not a person. */
export function isVoicePlan(name: string): 'phone' | 'calling_plan' | null {
  if (/VIRTUALUSER/i.test(name)) return null;
  if (/^MCOEV/i.test(name)) return 'phone';
  if (/^MCOPSTN/i.test(name)) return 'calling_plan';
  return null;
}

/** Parse the Teams user activity report CSV into per-UPN counts. */
export function parseTeamsActivity(csv: string): Map<string, { calls: number; meetings: number; last: string | null }> {
  const grid = parseCsv(csv || '');
  const out = new Map<string, { calls: number; meetings: number; last: string | null }>();
  if (!grid.length) return out;
  const h = grid[0].map((x) => x.trim().toLowerCase());
  const upn = h.indexOf('user principal name'), calls = h.indexOf('call count'), meetings = h.indexOf('meeting count'), last = h.indexOf('last activity date');
  if (upn < 0) return out;
  for (const r of grid.slice(1)) {
    const k = String(r[upn] || '').trim().toLowerCase();
    if (!k) continue;
    out.set(k, { calls: Number(r[calls]) || 0, meetings: Number(r[meetings]) || 0, last: (last >= 0 && r[last]) || null });
  }
  return out;
}

async function getJson(url: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
async function getAll(url: string, token: string, cap = 60): Promise<{ status: number; items: any[] }> {
  const items: any[] = [];
  let next: string | null = url, guard = 0, status = 200;
  while (next && guard++ < cap) {
    const r = await getJson(next, token);
    status = r.status;
    if (r.status !== 200) return { status, items };
    items.push(...(r.body.value || []));
    next = r.body['@odata.nextLink'] || null;
  }
  return { status, items };
}

export function teamsVoiceStatus(): TeamsVoiceStatus | null {
  const raw = getState('teams_voice.last');
  try { return raw ? (JSON.parse(raw) as TeamsVoiceStatus) : null; } catch { return null; }
}

/** Which of the needed application permissions the connected app holds. Null when not introspectable. */
export async function teamsPermissionGaps(): Promise<string[] | null> {
  const roles = await graphGrantedRoles();
  if (!roles || !roles.length) return null;
  const have = new Set(roles);
  const gaps: string[] = [];
  if (!['User.Read.All', 'Directory.Read.All', 'User.ReadWrite.All', 'Directory.ReadWrite.All'].some((r) => have.has(r))) gaps.push('User.Read.All');
  if (!['Organization.Read.All', 'Directory.Read.All', 'Directory.ReadWrite.All'].some((r) => have.has(r))) gaps.push('Organization.Read.All');
  if (!have.has('Reports.Read.All')) gaps.push('Reports.Read.All');
  if (!['CallRecords.Read.PstnCalls', 'CallRecords.Read.All'].some((r) => have.has(r))) gaps.push('CallRecords.Read.PstnCalls (optional)');
  return gaps;
}

export async function syncTeamsVoice(days = 90): Promise<TeamsVoiceStatus> {
  const period = days >= 180 ? 'D180' : days >= 90 ? 'D90' : days >= 30 ? 'D30' : 'D7';
  const status: TeamsVoiceStatus = { at: new Date().toISOString(), ok: false, users: 0, voiceUsers: 0, usage: false, pstn: false, concealed: false, gaps: [], period };
  const save = () => { setState('teams_voice.last', JSON.stringify(status)); return status; };
  if (!graphUsersConfigured()) { status.error = 'Microsoft Graph is not connected'; return save(); }
  let token: string | null = null;
  try { token = await graphToken(); } catch (err) { status.error = (err as Error).message.slice(0, 300); return save(); }
  if (!token) { status.error = 'could not get a Graph token'; return save(); }

  try {
    // 1. Which service plans are voice, from the tenant's subscriptions.
    const skus = await getAll(`${GRAPH}/subscribedSkus?$select=skuId,skuPartNumber,servicePlans`, token, 5);
    if (skus.status === 403) status.gaps.push('Organization.Read.All');
    const voicePlans = new Map<string, { name: string; kind: 'phone' | 'calling_plan' }>();
    const skuName = new Map<string, string>();
    for (const s of skus.items) {
      skuName.set(s.skuId, s.skuPartNumber);
      for (const p of s.servicePlans || []) {
        const kind = isVoicePlan(String(p.servicePlanName || ''));
        if (kind) voicePlans.set(String(p.servicePlanId).toLowerCase(), { name: p.servicePlanName, kind });
      }
    }

    // 2. Every user, their licenses and enabled plans.
    const users = await getAll(`${GRAPH}/users?$select=id,displayName,userPrincipalName,mail,accountEnabled,mobilePhone,assignedLicenses,assignedPlans&$top=999`, token);
    if (users.status !== 200) {
      status.error = users.status === 403 ? 'Graph returned Access Denied for users. Grant the User.Read.All application permission.' : `Graph users ${users.status}`;
      if (users.status === 403) status.gaps.push('User.Read.All');
      return save();
    }

    // 3. Teams activity (call and meeting counts). The report endpoint redirects to a CSV download.
    let activity = new Map<string, { calls: number; meetings: number; last: string | null }>();
    const rep = await fetch(`${GRAPH}/reports/getTeamsUserActivityUserDetail(period='${period}')`, { headers: { authorization: `Bearer ${token}` } });
    if (rep.ok) {
      activity = parseTeamsActivity(await rep.text());
      status.usage = true;
      // Microsoft hides names in reports by default: UPNs come back as hashes until that setting is off.
      const keys = [...activity.keys()];
      status.concealed = keys.length > 0 && keys.filter((k) => !k.includes('@')).length > keys.length / 2;
    } else if (rep.status === 403 || rep.status === 401) status.gaps.push('Reports.Read.All');

    // 4. PSTN calls (Calling Plan and Direct Routing), last up to 90 days, counted per UPN.
    const pstn = new Map<string, { calls: number; minutes: number }>();
    const to = new Date(), from = new Date(to.getTime() - Math.min(days, 90) * 86400000);
    const range = `fromDateTime=${from.toISOString()},toDateTime=${to.toISOString()}`;
    let pstnOk = false;
    for (const fn of ['getPstnCalls', 'getDirectRoutingCalls']) {
      const r = await getAll(`${GRAPH}/communications/callRecords/${fn}(${range})`, token, 80);
      if (r.status !== 200) continue;
      pstnOk = true;
      for (const c of r.items) {
        const k = String(c.userPrincipalName || '').toLowerCase();
        if (!k) continue;
        const secs = Number(c.duration) || (c.startDateTime && c.endDateTime ? (Date.parse(c.endDateTime) - Date.parse(c.startDateTime)) / 1000 : 0);
        const cur = pstn.get(k) || { calls: 0, minutes: 0 };
        cur.calls++; cur.minutes += secs / 60;
        pstn.set(k, cur);
      }
    }
    status.pstn = pstnOk;
    if (!pstnOk) status.gaps.push('CallRecords.Read.PstnCalls (optional)');

    // 5. Match to employees and replace the snapshot.
    const db = getDb();
    const empBy = new Map<string, number>();
    for (const e of db.prepare(`SELECT id, upn, work_email FROM employees`).all() as any[]) {
      for (const k of [e.upn, e.work_email]) if (k) empBy.set(String(k).toLowerCase(), e.id);
    }
    const ins = db.prepare(`INSERT INTO teams_voice_users (upn, entra_id, display_name, account_enabled, employee_id, mobile_phone, has_teams_phone, has_calling_plan,
      voice_plans, licenses, call_count, meeting_count, pstn_calls, pstn_minutes, last_activity, report_period, synced_at)
      VALUES (@upn, @entra_id, @display_name, @account_enabled, @employee_id, @mobile_phone, @has_teams_phone, @has_calling_plan,
      @voice_plans, @licenses, @call_count, @meeting_count, @pstn_calls, @pstn_minutes, @last_activity, @report_period, @synced_at)`);
    let voiceUsers = 0;
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM teams_voice_users`).run();
      for (const u of users.items) {
        const upn = String(u.userPrincipalName || '').toLowerCase();
        if (!upn) continue;
        const plans = (u.assignedPlans || [])
          .filter((p: any) => String(p.capabilityStatus) === 'Enabled')
          .map((p: any) => voicePlans.get(String(p.servicePlanId).toLowerCase()))
          .filter(Boolean) as { name: string; kind: string }[];
        const hasPhone = plans.some((p) => p.kind === 'phone');
        if (hasPhone) voiceUsers++;
        const a = activity.get(upn) || (u.mail ? activity.get(String(u.mail).toLowerCase()) : undefined);
        const pc = pstn.get(upn);
        ins.run({
          upn, entra_id: u.id, display_name: u.displayName || null, account_enabled: u.accountEnabled === false ? 0 : 1,
          employee_id: empBy.get(upn) ?? (u.mail ? empBy.get(String(u.mail).toLowerCase()) : undefined) ?? null,
          mobile_phone: u.mobilePhone || null, has_teams_phone: hasPhone ? 1 : 0, has_calling_plan: plans.some((p) => p.kind === 'calling_plan') ? 1 : 0,
          voice_plans: [...new Set(plans.map((p) => p.name))].join(', ') || null,
          licenses: (u.assignedLicenses || []).map((l: any) => skuName.get(l.skuId) || l.skuId).join(', ') || null,
          call_count: status.usage && !status.concealed ? (a ? a.calls : 0) : null,
          meeting_count: status.usage && !status.concealed ? (a ? a.meetings : 0) : null,
          pstn_calls: pstnOk ? (pc ? pc.calls : 0) : null, pstn_minutes: pstnOk ? (pc ? Math.round(pc.minutes) : 0) : null,
          last_activity: a?.last || null, report_period: period, synced_at: status.at,
        });
      }
    });
    tx();
    status.ok = true;
    status.users = users.items.length;
    status.voiceUsers = voiceUsers;
    return save();
  } catch (err) {
    status.error = (err as Error).message.slice(0, 300);
    return save();
  }
}

export async function syncTeamsVoiceForScheduler(): Promise<string> {
  const s = await syncTeamsVoice(90);
  if (!s.ok) return `not synced (${s.error || 'unavailable'})`;
  const missing = s.gaps.length ? `; missing: ${s.gaps.join(', ')}` : '';
  return `${s.users} users, ${s.voiceUsers} with Teams Phone${s.usage ? '' : ', no usage report'}${s.concealed ? ' (report names concealed)' : ''}${missing}`;
}
