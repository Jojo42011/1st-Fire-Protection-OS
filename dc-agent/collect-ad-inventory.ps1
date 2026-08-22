<#
  1st Fire Protection OS - on-prem AD inventory agent (P1, read-only)

  Reads Active Directory read-only and posts a full snapshot to the OS, which mirrors it and
  compares it against the employee record to surface accounts that need cleanup. This script does
  NOT change AD in any way: it only runs Get-ADUser and an HTTPS POST.

  Run it on a domain controller (or any domain-joined host with the ActiveDirectory module) as an
  account that can read the directory. See README.md for the scheduled-task setup.

  Usage:
    $env:AGENT_TOKEN = '<the token set on the server>'
    .\collect-ad-inventory.ps1                     # inventory the whole domain and post it
    .\collect-ad-inventory.ps1 -Ping               # just test connectivity + auth
    .\collect-ad-inventory.ps1 -SearchBase 'OU=Users,DC=1stfp,DC=local'   # scope the read
#>

[CmdletBinding()]
param(
  [string]$OsBaseUrl = 'https://first-fp-os.fly.dev',
  [string]$Token = $env:AGENT_TOKEN,
  [string]$SearchBase,
  [switch]$Ping
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ([string]::IsNullOrWhiteSpace($Token)) {
  Write-Error "No token. Set `$env:AGENT_TOKEN or pass -Token. This must match AGENT_TOKEN on the server."
  exit 1
}
$headers = @{ Authorization = "Bearer $Token" }
$base = $OsBaseUrl.TrimEnd('/')

if ($Ping) {
  $r = Invoke-RestMethod -Method Get -Uri "$base/api/ad-agent/ping" -Headers $headers
  Write-Host "OK - reached $base as an authorized agent. Server time: $($r.serverTime)"
  exit 0
}

Import-Module ActiveDirectory -ErrorAction Stop

$props = @('Title','mobile','department','physicalDeliveryOfficeName','mail','whenCreated',
           'lastLogonTimestamp','memberOf','userPrincipalName','distinguishedName','Enabled',
           'GivenName','Surname','DisplayName','SamAccountName','ObjectGUID')

$adParams = @{ Filter = '*'; Properties = $props }
if ($SearchBase) { $adParams['SearchBase'] = $SearchBase }

Write-Host "Reading AD..."
$adUsers = Get-ADUser @adParams

# Parent OU = the account's DN minus its own leading CN (split on the first unescaped comma).
function Get-ParentOu([string]$dn) {
  if ([string]::IsNullOrEmpty($dn)) { return $null }
  $parts = $dn -split '(?<!\\),', 2
  if ($parts.Count -eq 2) { return $parts[1] } else { return $null }
}
# Group display name = the leading CN of each memberOf DN.
function Get-GroupName([string]$dn) {
  if ([string]::IsNullOrEmpty($dn)) { return $null }
  $first = ($dn -split '(?<!\\),', 2)[0]
  if ($first -match '^CN=(.+)$') { return $Matches[1] } else { return $first }
}

$users = foreach ($u in $adUsers) {
  $groups = @()
  foreach ($g in @($u.memberOf)) {
    $groups += [pscustomobject]@{ name = (Get-GroupName $g); dn = $g }
  }
  $lastLogon = $null
  if ($u.lastLogonTimestamp) { try { $lastLogon = [DateTime]::FromFileTimeUtc([int64]$u.lastLogonTimestamp).ToString('o') } catch {} }
  $created = $null
  if ($u.whenCreated) { try { $created = ([DateTime]$u.whenCreated).ToString('o') } catch {} }

  [pscustomobject]@{
    objectGuid  = $u.ObjectGUID.ToString()
    sam         = $u.SamAccountName
    upn         = $u.UserPrincipalName
    displayName = $u.DisplayName
    givenName   = $u.GivenName
    surname     = $u.Surname
    title       = $u.Title
    mobile      = $u.mobile
    department  = $u.department
    office      = $u.physicalDeliveryOfficeName
    email       = $u.mail
    enabled     = [bool]$u.Enabled
    ou          = (Get-ParentOu $u.DistinguishedName)
    dn          = $u.DistinguishedName
    whenCreated = $created
    lastLogon   = $lastLogon
    groups      = $groups
  }
}

$payload = [pscustomobject]@{
  collectedAt = (Get-Date).ToUniversalTime().ToString('o')
  users       = @($users)
}
$json = $payload | ConvertTo-Json -Depth 6 -Compress

Write-Host "Posting $(@($users).Count) users..."
$resp = Invoke-RestMethod -Method Post -Uri "$base/api/ad-agent/inventory" -Headers $headers -ContentType 'application/json' -Body $json
Write-Host "Done. Server stored $($resp.stored) users and $($resp.groups) group memberships."
