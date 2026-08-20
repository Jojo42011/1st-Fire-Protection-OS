import { graphToken } from './licenseSources';

/**
 * Microsoft 365 outbound mail via Microsoft Graph sendMail.
 *
 * Reuses the same Entra app-registration credentials as the license integration
 * (MS_GRAPH_TENANT / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET). Sending additionally
 * requires the **Mail.Send** application permission granted to that app (admin consent) and a
 * MS_MAIL_FROM mailbox to send as (e.g. reviews@northstardemo.example).
 *
 * Keyless / permissionless-safe: returns { ok:false, error } instead of throwing, so a missing
 * grant or a transient failure never crashes the review sweep — the request just stays queued.
 */
export function mailConfigured(): boolean {
  const hasCreds = !!(process.env.MS_GRAPH_TOKEN || (process.env.MS_GRAPH_TENANT && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET));
  return hasCreds && !!process.env.MS_MAIL_FROM;
}

export function mailFrom(): string | null {
  return process.env.MS_MAIL_FROM || null;
}

/** Whether the app can send at all (has Graph creds). A specific from-address is still required per
 *  call (senderFor), but this is the credential-level check. */
export function mailCredsPresent(): boolean {
  return !!(process.env.MS_GRAPH_TOKEN || (process.env.MS_GRAPH_TENANT && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET));
}

/**
 * Send an HTML email via Microsoft 365. The 4th argument is backward-compatible: a string is treated
 * as the From display name (same as before), or pass { from, fromName } to send AS a specific mailbox
 * (e.g. reviews@, accountspayable@). Without an explicit from it falls back to MS_MAIL_FROM.
 */
export async function sendMail(to: string, subject: string, html: string, opts?: string | { from?: string; fromName?: string }): Promise<{ ok: boolean; error?: string }> {
  const o = typeof opts === 'string' ? { fromName: opts } : (opts || {});
  const from = o.from || process.env.MS_MAIL_FROM || '';
  if (!mailCredsPresent()) return { ok: false, error: 'Microsoft Graph is not connected' };
  if (!from) return { ok: false, error: 'no from mailbox (set MS_MAIL_FROM or a per-purpose sender address)' };
  try {
    const token = await graphToken();
    if (!token) return { ok: false, error: 'could not acquire a Graph token' };
    const message: Record<string, unknown> = {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: [{ emailAddress: { address: to } }],
    };
    // A friendly From display name (same mailbox address) so the customer recognizes the sender.
    if (o.fromName) message.from = { emailAddress: { name: o.fromName, address: from } };
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
    if (res.status === 202 || res.ok) return { ok: true };
    return { ok: false, error: `graph sendMail ${res.status}: ${await res.text()}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
