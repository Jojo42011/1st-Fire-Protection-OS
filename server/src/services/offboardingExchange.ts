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

/**
 * A single self-contained offboarding script to run ON A DOMAIN CONTROLLER. It does the on-prem AD
 * steps (disable + password reset, remove from all groups, hide from GAL) and, once
 * Connect-ExchangeOnline is run, the mailbox steps (forward, auto-reply, convert to shared). Every
 * step is wrapped in try/catch and, ONLY on success, calls back to the OS to mark its checklist task
 * done, so the board reflects what actually happened. It reads $env:AGENT_TOKEN (the same token the AD
 * agent uses) so the token is never baked into the file.
 */
interface Resolved { r: any; sam: string; upn: string; items: any[]; idFor: (ac: string) => number | null; fwd: string; name: string; contact: string; }
function resolve(requestId: number): { ok: false; error: string } | ({ ok: true } & Resolved) {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM offboarding_requests WHERE id = ?`).get(requestId) as any;
  if (!r) return { ok: false, error: 'request not found' };
  let sam = r.sam as string | null;
  let upn = r.upn as string | null;
  if (!sam || !upn) {
    const ad = db.prepare(`SELECT sam, upn FROM ad_users WHERE (object_guid IS NOT NULL AND object_guid = ?) OR (upn IS NOT NULL AND lower(upn)=lower(?)) LIMIT 1`).get(r.object_guid || '', r.upn || '') as any;
    if (ad) { sam = sam || ad.sam; upn = upn || ad.upn; }
  }
  if (!sam) return { ok: false, error: 'no sAMAccountName on file for this person' };
  const items = db.prepare(`SELECT id, action_code, status FROM offboarding_items WHERE request_id = ?`).all(requestId) as any[];
  const idFor = (ac: string): number | null => { const it = items.find((x) => x.action_code === ac && x.status === 'pending'); return it ? it.id : null; };
  const fwd = (r.forward_to || r.manager_email || '') as string;
  const name = (r.name || 'This employee') as string;
  return { ok: true, r, sam, upn: upn || '', items, idFor, fwd, name, contact: fwd || 'our office' };
}

// The shared preamble: OS URL, token from env, and the Complete-Item callback.
function preamble(L: string[], sam: string, upn: string, fwd: string): void {
  L.push('$ErrorActionPreference = "Stop"');
  L.push('$Os    = "https://first-fp-os.fly.dev"');
  L.push('$Token = $env:AGENT_TOKEN');
  L.push('if (-not $Token) { Write-Error "Set `$env:AGENT_TOKEN first (the same token the AD agent uses)."; return }');
  L.push(`$Sam   = ${psq(sam)}`);
  L.push(`$Upn   = ${psq(upn)}`);
  L.push(`$Fwd   = ${psq(fwd)}`);
  L.push('$Hdr   = @{ Authorization = "Bearer $Token" }');
  L.push('function Complete-Item($id) {');
  L.push('  if (-not $id) { return }');
  L.push('  try { Invoke-RestMethod -Method Post -Uri "$Os/api/ad-agent/offboarding-item/$id/complete" -Headers $Hdr | Out-Null; Write-Host "  -> marked task $id done" }');
  L.push('  catch { Write-Warning "  could not mark task $id done: $($_.Exception.Message)" }');
  L.push('}');
}

/** Script 1: the on-prem AD steps only. RUN ON A DOMAIN CONTROLLER. */
export function buildDcOffboardingScript(requestId: number): ExchangeScript {
  const R = resolve(requestId);
  if (!R.ok) return { ok: false, error: R.error };
  const { sam, upn, fwd, idFor, name } = R;
  const L: string[] = [];
  L.push(`# Offboarding (on-prem AD): ${name} (${upn || sam}) - RUN ON A DOMAIN CONTROLLER.`);
  L.push('# Disables the account and strips group membership. Run the cloud script (mailbox + license +');
  L.push('# session revoke) on your own computer. Each step marks its task done ONLY if it succeeds.');
  preamble(L, sam, upn, fwd);
  L.push('Import-Module ActiveDirectory');
  L.push('');
  L.push('# ---- Disable the account + reset the password ----');
  L.push('try {');
  L.push('  $u = Get-ADUser -Identity $Sam');
  L.push('  Disable-ADAccount -Identity $u');
  L.push('  $rnd = -join ((48..57)+(65..90)+(97..122)+(33,35,36,37,38,42) | Get-Random -Count 20 | ForEach-Object { [char]$_ })');
  L.push('  Set-ADAccountPassword -Identity $u -Reset -NewPassword (ConvertTo-SecureString $rnd -AsPlainText -Force)');
  L.push(`  Write-Host "Disabled $Sam"; Complete-Item ${idFor('ad_disable') ?? '$null'}`);
  L.push('} catch { Write-Warning "Disable failed: $($_.Exception.Message)" }');
  L.push('');
  L.push('# ---- Remove from every group (primary group Domain Users is left in place) ----');
  L.push('try {');
  L.push('  $u = Get-ADUser -Identity $Sam -Properties MemberOf');
  L.push('  foreach ($dn in @($u.MemberOf)) { Remove-ADGroupMember -Identity $dn -Members $u -Confirm:$false }');
  L.push(`  Write-Host "Removed from $(@($u.MemberOf).Count) groups"; Complete-Item ${idFor('groups_remove') ?? '$null'}`);
  L.push('} catch { Write-Warning "Group removal failed: $($_.Exception.Message)" }');
  L.push('');
  L.push('Write-Host "AD offboarding complete. Now run the cloud script on your computer."');
  return { ok: true, upn, script: L.join('\n') };
}

/** Script 2: the cloud steps (Exchange Online + Microsoft Graph). RUN ON YOUR OWN COMPUTER, after
 *  Connect-ExchangeOnline and Connect-MgGraph. Order: convert to shared FIRST, then remove the
 *  license, revoke sessions, set forwarding + auto-reply. */
export function buildCloudOffboardingScript(requestId: number): ExchangeScript {
  const R = resolve(requestId);
  if (!R.ok) return { ok: false, error: R.error };
  const { sam, upn, fwd, idFor, name, contact } = R;
  const odUrl = upn ? `https://1stfp-my.sharepoint.com/personal/${upn.replace(/[@.]/g, '_').toLowerCase()}` : '';
  const L: string[] = [];
  L.push(`# Offboarding (cloud): ${name} (${upn}) - RUN ON YOUR COMPUTER.`);
  L.push('# Prereqs, run first:');
  L.push('#   Connect-ExchangeOnline');
  L.push('#   Connect-MgGraph -Scopes "User.ReadWrite.All"');
  L.push('#   Connect-SPOService -Url https://1stfp-admin.sharepoint.com   (for the OneDrive step)');
  L.push('# Order: convert to shared, drop the license, revoke sessions, forward, auto-reply, reassign OneDrive.');
  L.push('# Each step marks its task done ONLY if it succeeds. Needs $env:AGENT_TOKEN set.');
  preamble(L, sam, upn, fwd);
  L.push(`$Od    = ${psq(odUrl)}`);
  L.push('');
  L.push('# ---- 1. Convert the mailbox to shared (do this before dropping the license) ----');
  L.push('try {');
  L.push(`  Set-Mailbox -Identity $Upn -Type Shared; Write-Host "Converted to shared"; Complete-Item ${idFor('mbx_shared') ?? '$null'}`);
  L.push('} catch { Write-Warning "Convert-to-shared failed: $($_.Exception.Message)" }');
  L.push('');
  L.push('# ---- 2. Remove the Microsoft 365 license (Graph) ----');
  L.push('try {');
  L.push('  $skus = @((Get-MgUserLicenseDetail -UserId $Upn).SkuId)');
  L.push('  if ($skus.Count) { Set-MgUserLicense -UserId $Upn -RemoveLicenses $skus -AddLicenses @{} | Out-Null; Write-Host "Removed $($skus.Count) license(s)" }');
  L.push('  else { Write-Host "No direct licenses to remove" }');
  L.push(`  Complete-Item ${idFor('license_remove') ?? '$null'}`);
  L.push('} catch { Write-Warning "License removal failed: $($_.Exception.Message) (group-based licenses are removed via the group)" }');
  L.push('');
  L.push('# ---- 3. Revoke all 365 sign-in sessions (Graph) ----');
  L.push('try {');
  L.push('  Revoke-MgUserSignInSession -UserId $Upn | Out-Null; Write-Host "Revoked sign-in sessions"');
  L.push(`  Complete-Item ${idFor('revoke_sessions') ?? '$null'}`);
  L.push('} catch { Write-Warning "Session revoke failed: $($_.Exception.Message)" }');
  L.push('');
  L.push('# ---- 4. Forward new mail to the manager ----');
  L.push('try {');
  L.push(`  if ($Fwd) { Set-Mailbox -Identity $Upn -ForwardingAddress $Fwd -DeliverToMailboxAndForward $true; Write-Host "Forwarding to $Fwd"; Complete-Item ${idFor('fwd_set') ?? '$null'} }`);
  L.push('} catch { Write-Warning "Forwarding failed: $($_.Exception.Message)" }');
  L.push('');
  L.push('# ---- 5. Auto-reply ----');
  L.push('try {');
  L.push('  Set-MailboxAutoReplyConfiguration -Identity $Upn -AutoReplyState Enabled `');
  L.push(`    -InternalMessage ${psq(`${name} is no longer with 1st Fire Protection. Please contact ${contact} for assistance.`)} \``);
  L.push(`    -ExternalMessage ${psq(`Thank you for your message. ${name} is no longer with 1st Fire Protection. Please contact ${contact} for assistance.`)}`);
  L.push(`  Write-Host "Auto-reply set"; Complete-Item ${idFor('autoreply_set') ?? '$null'}`);
  L.push('} catch { Write-Warning "Auto-reply failed: $($_.Exception.Message)" }');
  L.push('');
  L.push('# ---- 6. Reassign OneDrive: make the manager an admin of the departing user\'s OneDrive ----');
  L.push('if (Get-Command Set-SPOUser -ErrorAction SilentlyContinue) {');
  L.push('  try {');
  L.push(`    if ($Fwd -and $Od) { Set-SPOUser -Site $Od -LoginName $Fwd -IsSiteCollectionAdmin $true | Out-Null; Write-Host "Granted $Fwd access to $Od"; Complete-Item ${idFor('data_reassign') ?? '$null'} }`);
  L.push('  } catch { Write-Warning "OneDrive reassignment failed: $($_.Exception.Message)" }');
  L.push('} else { Write-Warning "SharePoint Online not connected - run Connect-SPOService -Url https://1stfp-admin.sharepoint.com to reassign OneDrive." }');
  L.push('');
  L.push('Write-Host "Cloud offboarding complete."');
  return { ok: true, upn, script: L.join('\n') };
}

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
  L.push('# Hide from the global address list. This mailbox is synced from on-prem AD, so Exchange Online');
  L.push('# refuses HiddenFromAddressListsEnabled here; it must be set on-prem, and only if the AD Exchange');
  L.push('# schema is present. On a domain controller (then Start-ADSyncSyncCycle -PolicyType Delta):');
  L.push(`#   Set-ADUser -Identity ${r.sam ? psq(r.sam) : "<sam>"} -Replace @{ msExchHideFromAddressLists = $true }`);
  L.push('# If that errors "attribute does not exist", the schema is not extended: skip GAL-hide. The');
  L.push('# account is disabled now and drops off the GAL when it is deleted at retention.');
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
