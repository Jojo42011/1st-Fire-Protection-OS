/**
 * Microsoft Graph: server-side cloud offboarding.
 *
 * Runs the cloud steps of an offboarding directly against Microsoft Graph with the app registration's
 * OWN application permissions (client credentials), so nobody has to run Connect-MgGraph /
 * Connect-ExchangeOnline / Connect-SPOService on a laptop, and the Graph + Exchange + SharePoint
 * PowerShell modules never have to coexist in one terminal (the conflict that blocks the manual script).
 *
 * Reuses the shared Entra app credentials (MS_GRAPH_TENANT / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET).
 * Every function is keyless- and permissionless-safe: it returns { ok, error } instead of throwing, so a
 * missing grant or a transient failure never crashes the board; the step just stays pending with a clear
 * reason. Idempotent throughout: re-running a completed step is a no-op success.
 *
 * Application permissions required on the app registration (admin consent), by step:
 *   - revoke_sessions   User.ReadWrite.All              (block sign-in + revokeSignInSessions)
 *   - license_remove    User.ReadWrite.All, Organization.Read.All
 *   - autoreply_set     MailboxSettings.ReadWrite
 *   - fwd_set           Mail.ReadWrite                  (creates a forwarding inbox rule)
 *   - data_reassign     Files.ReadWrite.All             (grant the manager the OneDrive)
 *
 * NOT server-runnable: converting a mailbox to a shared mailbox (mbx_shared) has no Graph API; it stays
 * an Exchange Online step. Everything else in the cloud script is covered here.
 */
import { graphToken } from './licenseSources';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export function graphOffboardConfigured(): boolean {
  return !!(process.env.MS_GRAPH_TOKEN || (process.env.MS_GRAPH_TENANT && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET));
}

/** The offboarding action codes this service can run server-side, with a short human label. */
const CLOUD_ACTIONS: Record<string, string> = {
  revoke_sessions: 'Block sign-in and revoke all Microsoft 365 sessions',
  license_remove: 'Remove the Microsoft 365 license',
  autoreply_set: 'Set the mailbox auto-reply',
  fwd_set: 'Forward new mail to the manager',
  data_reassign: 'Grant the manager access to the OneDrive',
};
export function isCloudExecutable(actionCode: string): boolean {
  return !!CLOUD_ACTIONS[actionCode];
}
export function cloudActionLabel(actionCode: string): string | null {
  return CLOUD_ACTIONS[actionCode] || null;
}

/** A denied response from Graph, turned into a clear "add this permission" message. */
function accessDenied(perm: string): string {
  return `Graph returned Access Denied. Add the ${perm} application permission to the app registration and grant admin consent.`;
}

async function resolveUserId(token: string, upn: string): Promise<string | null> {
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(upn)}?$select=id`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const j = (await res.json()) as { id?: string };
  return j.id || null;
}

type StepResult = { ok: boolean; error?: string; detail?: string; already?: boolean };

/**
 * Block sign-in (accountEnabled=false) and revoke every refresh/session token. For a hybrid-synced
 * account the on-prem DC masters accountEnabled, so the disable there is authoritative and this call is
 * a belt-and-suspenders cloud block; the session revoke is the part that has real teeth immediately.
 */
export async function revokeAndBlockSignIn(upn: string): Promise<StepResult> {
  if (!graphOffboardConfigured()) return { ok: false, error: 'Microsoft Graph is not connected' };
  if (!upn) return { ok: false, error: 'no UPN on file for this person' };
  try {
    const token = await graphToken();
    if (!token) return { ok: false, error: 'could not acquire a Graph token' };
    const id = await resolveUserId(token, upn);
    if (!id) return { ok: false, error: `no directory user for ${upn}` };

    // Block sign-in (best-effort; a synced account may re-enable on next sync, which is expected).
    const patch = await fetch(`${GRAPH}/users/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accountEnabled: false }),
    });
    let blocked = patch.status === 204 || patch.ok;

    // Revoke sessions: invalidates all refresh tokens so open sessions cannot keep working.
    const revoke = await fetch(`${GRAPH}/users/${id}/revokeSignInSessions`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    if (!revoke.ok && revoke.status !== 204) {
      if (revoke.status === 401 || revoke.status === 403) return { ok: false, error: accessDenied('User.ReadWrite.All') };
      return { ok: false, error: `graph revokeSignInSessions ${revoke.status}: ${(await revoke.text()).slice(0, 200)}` };
    }
    return { ok: true, detail: blocked ? 'Sign-in blocked and all sessions revoked.' : 'Sessions revoked (sign-in block is mastered on-prem for this account).' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Remove every directly assigned Microsoft 365 license. Group-based licenses are removed via the group. */
export async function removeAllLicenses(upn: string): Promise<StepResult> {
  if (!graphOffboardConfigured()) return { ok: false, error: 'Microsoft Graph is not connected' };
  if (!upn) return { ok: false, error: 'no UPN on file for this person' };
  try {
    const token = await graphToken();
    if (!token) return { ok: false, error: 'could not acquire a Graph token' };
    const id = await resolveUserId(token, upn);
    if (!id) return { ok: false, error: `no directory user for ${upn}` };

    const det = await fetch(`${GRAPH}/users/${id}/licenseDetails?$select=skuId`, { headers: { authorization: `Bearer ${token}` } });
    if (!det.ok) {
      if (det.status === 401 || det.status === 403) return { ok: false, error: accessDenied('User.ReadWrite.All / Organization.Read.All') };
      return { ok: false, error: `graph licenseDetails ${det.status}: ${(await det.text()).slice(0, 200)}` };
    }
    const j = (await det.json()) as { value?: { skuId: string }[] };
    const skus = (j.value || []).map((l) => l.skuId).filter(Boolean);
    if (!skus.length) return { ok: true, already: true, detail: 'No directly assigned licenses to remove.' };

    const res = await fetch(`${GRAPH}/users/${id}/assignLicense`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ addLicenses: [], removeLicenses: skus }),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, error: accessDenied('User.ReadWrite.All') };
      return { ok: false, error: `graph assignLicense ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true, detail: `Removed ${skus.length} license${skus.length === 1 ? '' : 's'}.` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Turn on an internal + external auto-reply on the departing user's mailbox (no end date). */
export async function setAutoReply(upn: string, name: string, contact: string): Promise<StepResult> {
  if (!graphOffboardConfigured()) return { ok: false, error: 'Microsoft Graph is not connected' };
  if (!upn) return { ok: false, error: 'no UPN on file for this person' };
  try {
    const token = await graphToken();
    if (!token) return { ok: false, error: 'could not acquire a Graph token' };
    const id = await resolveUserId(token, upn);
    if (!id) return { ok: false, error: `no directory user for ${upn}` };
    const internal = `${name} is no longer with 1st Fire Protection. Please contact ${contact} for assistance.`;
    const external = `Thank you for your message. ${name} is no longer with 1st Fire Protection. Please contact ${contact} for assistance.`;
    const res = await fetch(`${GRAPH}/users/${id}/mailboxSettings`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        automaticRepliesSetting: {
          status: 'alwaysEnabled',
          externalAudience: 'all',
          internalReplyMessage: internal,
          externalReplyMessage: external,
        },
      }),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, error: accessDenied('MailboxSettings.ReadWrite') };
      return { ok: false, error: `graph mailboxSettings ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true, detail: 'Auto-reply enabled (internal and external).' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Forward new mail to the manager by creating a server-side inbox rule that redirects and keeps a copy.
 * Idempotent by name: an existing "1st FP Offboarding forward" rule is replaced so re-running is safe.
 */
export async function setForwarding(upn: string, fwd: string): Promise<StepResult> {
  if (!graphOffboardConfigured()) return { ok: false, error: 'Microsoft Graph is not connected' };
  if (!upn) return { ok: false, error: 'no UPN on file for this person' };
  if (!fwd) return { ok: false, error: 'no forwarding address (set a manager / forward-to on the request)' };
  try {
    const token = await graphToken();
    if (!token) return { ok: false, error: 'could not acquire a Graph token' };
    const id = await resolveUserId(token, upn);
    if (!id) return { ok: false, error: `no directory user for ${upn}` };
    const RULE = '1st FP Offboarding forward';
    const base = `${GRAPH}/users/${id}/mailFolders/inbox/messageRules`;

    // Remove any prior copy of our rule so this is idempotent.
    const existing = await fetch(`${base}?$select=id,displayName`, { headers: { authorization: `Bearer ${token}` } });
    if (existing.ok) {
      const ej = (await existing.json()) as { value?: { id: string; displayName: string }[] };
      for (const r of ej.value || []) {
        if (r.displayName === RULE) {
          // eslint-disable-next-line no-await-in-loop
          await fetch(`${base}/${r.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
        }
      }
    } else if (existing.status === 401 || existing.status === 403) {
      return { ok: false, error: accessDenied('Mail.ReadWrite') };
    }

    const res = await fetch(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: RULE,
        sequence: 1,
        isEnabled: true,
        actions: { forwardTo: [{ emailAddress: { address: fwd } }], stopProcessingRules: false },
      }),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, error: accessDenied('Mail.ReadWrite') };
      return { ok: false, error: `graph messageRules ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true, detail: `New mail forwards to ${fwd} (a copy stays in the mailbox).` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Grant the manager write access to the departing user's OneDrive root (the SharePoint delegation). */
export async function delegateOneDrive(upn: string, managerUpn: string): Promise<StepResult> {
  if (!graphOffboardConfigured()) return { ok: false, error: 'Microsoft Graph is not connected' };
  if (!upn) return { ok: false, error: 'no UPN on file for this person' };
  if (!managerUpn) return { ok: false, error: 'no manager / forward-to on the request to grant access to' };
  try {
    const token = await graphToken();
    if (!token) return { ok: false, error: 'could not acquire a Graph token' };
    const id = await resolveUserId(token, upn);
    if (!id) return { ok: false, error: `no directory user for ${upn}` };

    // Confirm the user has a provisioned OneDrive first (a clearer message than a raw 404 on invite).
    const drive = await fetch(`${GRAPH}/users/${id}/drive?$select=id`, { headers: { authorization: `Bearer ${token}` } });
    if (!drive.ok) {
      if (drive.status === 401 || drive.status === 403) return { ok: false, error: accessDenied('Files.ReadWrite.All') };
      if (drive.status === 404) return { ok: false, error: 'this user has no provisioned OneDrive to delegate' };
      return { ok: false, error: `graph drive ${drive.status}: ${(await drive.text()).slice(0, 200)}` };
    }
    const res = await fetch(`${GRAPH}/users/${id}/drive/root/invite`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        recipients: [{ email: managerUpn }],
        roles: ['write'],
        requireSignIn: true,
        sendInvitation: false,
        message: 'Access to a departing team member\'s OneDrive for handover.',
      }),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, error: accessDenied('Files.ReadWrite.All') };
      return { ok: false, error: `graph drive invite ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true, detail: `Granted ${managerUpn} write access to the OneDrive.` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Run one cloud offboarding action for a request row. The request supplies the UPN and the forward/
 * manager target; `name`/`contact` shape the auto-reply. Returns a StepResult; the caller marks the
 * board item done on ok and audits either way.
 */
export async function runCloudAction(actionCode: string, req: { upn?: string | null; name?: string | null; forward_to?: string | null; manager_email?: string | null }): Promise<StepResult> {
  const upn = (req.upn || '').trim();
  const fwd = (req.forward_to || req.manager_email || '').trim();
  const name = (req.name || 'This employee').trim();
  const contact = fwd || 'our office';
  switch (actionCode) {
    case 'revoke_sessions': return revokeAndBlockSignIn(upn);
    case 'license_remove': return removeAllLicenses(upn);
    case 'autoreply_set': return setAutoReply(upn, name, contact);
    case 'fwd_set': return setForwarding(upn, fwd);
    case 'data_reassign': return delegateOneDrive(upn, fwd);
    default: return { ok: false, error: `"${actionCode}" is not a server-runnable cloud action` };
  }
}
