import { getDb } from '../db/index';

/**
 * Exchange Online offboarding script for one request. The mailbox lifecycle (forwarding, auto-reply,
 * hide-from-GAL, convert-to-shared, retire) lives in Exchange Online, and converting a mailbox to
 * shared has no Microsoft Graph equivalent, so this is generated as EXO PowerShell the operator runs
 * (Connect-ExchangeOnline), rather than run server-side. Steps are grouped by when to run them and are
 * idempotent, so the script can be re-run as the offboarding moves through its stages.
 */

const psq = (s: string) => `'${String(s || '').replace(/'/g, "''")}'`;

export interface ExchangeScript { ok: boolean; error?: string; upn?: string; script?: string }

export function buildExchangeScript(requestId: number): ExchangeScript {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM offboarding_requests WHERE id = ?`).get(requestId) as any;
  if (!r) return { ok: false, error: 'request not found' };
  const upn = r.upn as string | null;
  if (!upn) return { ok: false, error: 'no UPN on file for this request' };
  const fwd = (r.forward_to || r.manager_email || '') as string;
  const name = (r.name || 'This employee') as string;
  const contact = fwd || 'our office';
  const del = r.mailbox_action !== 'hold';

  const L: string[] = [];
  L.push(`# Exchange Online offboarding for ${name} (${upn})`);
  L.push('# Connect first:  Connect-ExchangeOnline');
  L.push('# Steps are grouped by WHEN to run them. Everything here is safe to re-run.');
  L.push('');
  L.push(`$U   = ${psq(upn)}`);
  L.push(`$Fwd = ${psq(fwd)}`);
  L.push('');
  L.push('# ============ Last working day ============');
  L.push('# Hide from the global address list');
  L.push('Set-Mailbox -Identity $U -HiddenFromAddressListsEnabled $true');
  L.push('');
  L.push(`# Forward new mail to the manager and keep a copy in the mailbox (until ${r.forward_until || 'the forward date'})`);
  L.push('if ($Fwd) { Set-Mailbox -Identity $U -ForwardingAddress $Fwd -DeliverToMailboxAndForward $true }');
  L.push('');
  L.push('# Turn on the auto-reply');
  L.push('Set-MailboxAutoReplyConfiguration -Identity $U -AutoReplyState Enabled `');
  L.push(`  -InternalMessage ${psq(`${name} is no longer with 1st Fire Protection. Please contact ${contact} for assistance.`)} \``);
  L.push(`  -ExternalMessage ${psq(`Thank you for your message. ${name} is no longer with 1st Fire Protection. Please contact ${contact} for assistance.`)}`);
  L.push('');
  L.push('# ============ Within a week: convert to shared + drop the paid license ============');
  L.push('# Convert to a shared mailbox so mail is retained without a paid seat');
  L.push('Set-Mailbox -Identity $U -Type Shared');
  L.push('');
  L.push('# Remove the Microsoft 365 license (licenses live in Entra/Graph, not Exchange). In a Graph session:');
  L.push('#   Connect-MgGraph -Scopes "User.ReadWrite.All"');
  L.push('#   $skus = (Get-MgUserLicenseDetail -UserId $U).SkuId');
  L.push('#   if ($skus) { Set-MgUserLicense -UserId $U -RemoveLicenses $skus -AddLicenses @{} }');
  L.push('');
  L.push(`# ============ On ${r.forward_until || 'the forward-until date'}: stop forwarding + auto-reply ============`);
  L.push('# Set-Mailbox -Identity $U -ForwardingAddress $null -DeliverToMailboxAndForward $false');
  L.push('# Set-MailboxAutoReplyConfiguration -Identity $U -AutoReplyState Disabled');
  L.push('');
  L.push(`# ============ At retention (${r.retain_until || 'the retain-until date'}): ${del ? 'delete' : 'hold'} the mailbox ============`);
  if (del) {
    L.push('# Delete the shared mailbox (only after the retention date, and after AD delete has synced):');
    L.push('# Remove-Mailbox -Identity $U -Confirm:$false');
  } else {
    L.push('# Keep the shared mailbox. Place it on hold so it is preserved as an inactive mailbox:');
    L.push('# Set-Mailbox -Identity $U -LitigationHoldEnabled $true');
  }
  return { ok: true, upn, script: L.join('\n') };
}
