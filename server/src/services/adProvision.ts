import { randomBytes } from 'crypto';
import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { catalogByKind } from './onboardingCatalog';

/**
 * On-prem AD new-hire provisioning (hybrid identity).
 *
 * 1st Fire runs on-prem Active Directory synced up to Entra via Azure AD Connect. New accounts
 * must therefore be born in on-prem AD (not created cloud-only through Graph, which would make a
 * mismatched duplicate), and on-prem group membership must be set on-prem (Add-ADGroupMember);
 * a cloud-side Graph add does not write back to AD. So instead of calling Graph, the OS GENERATES
 * a ready-to-run PowerShell script the People admin / IT runs on a domain controller: it creates
 * the user (New-ADUser) and adds them to each mapped on-prem security group. Direct license
 * assignment is a cloud-side step that happens after the account syncs to Entra, so the script
 * notes it rather than performing it.
 *
 * The OU distinguished name, the UPN domain and the default license SKU are editable settings
 * (system_state), so IT sets them once. Until the OU is set, the script carries a clearly marked
 * placeholder and a warning so nobody runs it blind.
 */

const K_OU = 'ad_target_ou';
const K_DOMAIN = 'ad_upn_domain';
const K_SKU = 'ad_license_sku';
const K_OFFICE_OU = 'ad_office_ou_map';
const K_DEPT_OU = 'ad_dept_ou_map';

const DEFAULT_DOMAIN = '1stfpservices.com';
const OU_PLACEHOLDER = 'OU=New Hires,OU=Users,DC=1stfp,DC=local';

export interface AdSettings {
  targetOu: string | null; // the default OU, used when neither department nor office has a mapping
  upnDomain: string;
  licenseSku: string | null;
  officeOuMap: Record<string, string>; // office label -> OU distinguished name
  departmentOuMap: Record<string, string>; // department -> OU DN; takes precedence over office
}

function readMap(key: string): Record<string, string> {
  const raw = getState(key);
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** The editable AD provisioning settings, with the UPN domain defaulted. */
export function getAdSettings(): AdSettings {
  return {
    targetOu: getState(K_OU) || null,
    upnDomain: getState(K_DOMAIN) || DEFAULT_DOMAIN,
    licenseSku: getState(K_SKU) || null,
    officeOuMap: readMap(K_OFFICE_OU),
    departmentOuMap: readMap(K_DEPT_OU),
  };
}

function cleanMap(m: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) { const dn = String(v || '').trim(); if (k && dn) clean[k] = dn; }
  return clean;
}

/** Update whichever settings are provided. Blank clears back to the default/placeholder. */
export function setAdSettings(patch: { targetOu?: string; upnDomain?: string; licenseSku?: string; officeOuMap?: Record<string, string>; departmentOuMap?: Record<string, string> }): AdSettings {
  if (patch.targetOu !== undefined) setState(K_OU, String(patch.targetOu).trim());
  if (patch.upnDomain !== undefined) setState(K_DOMAIN, String(patch.upnDomain).trim() || DEFAULT_DOMAIN);
  if (patch.licenseSku !== undefined) setState(K_SKU, String(patch.licenseSku).trim());
  if (patch.officeOuMap !== undefined && patch.officeOuMap && typeof patch.officeOuMap === 'object') setState(K_OFFICE_OU, JSON.stringify(cleanMap(patch.officeOuMap)));
  if (patch.departmentOuMap !== undefined && patch.departmentOuMap && typeof patch.departmentOuMap === 'object') setState(K_DEPT_OU, JSON.stringify(cleanMap(patch.departmentOuMap)));
  return getAdSettings();
}

export type OuMatch = 'department' | 'office' | 'default';

/**
 * Resolve the OU a hire should be created in. Department wins over office, but ONLY for departments
 * that are explicitly mapped: back-office functions (Accounting, IT, HR) live in MGMT OUs regardless
 * of which office they nominally sit in, while field staff (whose department is not mapped) route by
 * office. Falls back to the default OU.
 */
export function resolveOu(department: string | null | undefined, office: string | null | undefined, settings: AdSettings): { ou: string; isPlaceholder: boolean; matched: OuMatch } {
  const find = (map: Record<string, string>, key: string | null | undefined): string | null => {
    if (!key) return null;
    const hit = Object.keys(map || {}).find((k) => k.toLowerCase() === String(key).toLowerCase());
    return hit && map[hit] ? map[hit] : null;
  };
  const dept = find(settings.departmentOuMap, department);
  if (dept) return { ou: dept, isPlaceholder: false, matched: 'department' };
  const off = find(settings.officeOuMap, office);
  if (off) return { ou: off, isPlaceholder: false, matched: 'office' };
  if (settings.targetOu) return { ou: settings.targetOu, isPlaceholder: false, matched: 'default' };
  return { ou: OU_PLACEHOLDER, isPlaceholder: true, matched: 'default' };
}

/** first.last, ASCII, lower-case, punctuation-stripped: the sAMAccountName / UPN local part. */
function sanitize(part: string): string {
  return String(part || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** Split a full name into first + last when the hire is not a bound BambooHR record. */
function splitName(full: string): { first: string; last: string } {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts[parts.length - 1] };
}

/** A one-time temp password that meets AD default complexity (upper, lower, digit, symbol). */
function tempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const symbol = '!@#$%*?';
  const all = upper + lower + digit + symbol;
  const b = randomBytes(16);
  const pick = (set: string, i: number) => set[b[i] % set.length];
  // Guarantee one of each class, then fill to 14 chars.
  const chars = [pick(upper, 0), pick(lower, 1), pick(digit, 2), pick(symbol, 3)];
  for (let i = 4; i < 14; i++) chars.push(pick(all, i));
  return chars.join('');
}

export interface ProvisionScript {
  ok: boolean;
  error?: string;
  script?: string;
  filename?: string;
  upn?: string;
  sam?: string;
  securityGroups?: string[];
  sharepointGroups?: string[];
  warnings?: string[];
}

export interface ProvisionPlan {
  ok: boolean;
  error?: string;
  first: string;
  last: string;
  displayName: string;
  sam: string;
  upn: string;
  ou: string;
  ouIsPlaceholder: boolean;
  password: string;
  securityGroups: string[];
  sharepointGroups: string[];
  licenseSku: string | null;
  warnings: string[];
}

/**
 * Compute the structured account plan for one onboarding request: name, UPN, sAM, OU, a fresh
 * one-time password, and the mapped groups. Both the generated script and the DC create-user job
 * are rendered from this, so they never drift. Reads only; writes no state.
 */
export function buildProvisionPlan(requestId: number): ProvisionPlan {
  const db = getDb();
  const request = db.prepare(`SELECT * FROM onboarding_requests WHERE id = ?`).get(requestId) as any;
  const empty: ProvisionPlan = { ok: false, first: '', last: '', displayName: '', sam: '', upn: '', ou: '', ouIsPlaceholder: true, password: '', securityGroups: [], sharepointGroups: [], licenseSku: null, warnings: [] };
  if (!request) return { ...empty, error: 'request not found' };

  const settings = getAdSettings();
  const warnings: string[] = [];

  // Name + office + department: prefer the bound BambooHR record; fall back to parsing the typed name.
  let first = '', last = '', office: string | null = null, department: string | null = null;
  if (request.employee_id) {
    const e = db.prepare(`SELECT legal_first_name, legal_last_name, office, department FROM employees WHERE id = ?`).get(request.employee_id) as
      | { legal_first_name: string | null; legal_last_name: string | null; office: string | null; department: string | null }
      | undefined;
    if (e) { first = e.legal_first_name || ''; last = e.legal_last_name || ''; office = e.office || null; department = e.department || null; }
  }
  if (!office) office = request.office || null;
  if (!first && !last) { const s = splitName(request.name); first = s.first; last = s.last; }

  const fSan = sanitize(first);
  const lSan = sanitize(last);
  if (!fSan || !lSan) warnings.push('Could not derive a clean first.last from the name: check the account name before running.');
  const sam = [fSan, lSan].filter(Boolean).join('.') || 'new.hire';
  const upn = `${sam}@${settings.upnDomain}`;

  // Resolve the OU: department mapping (back-office functions) wins over office, then the default OU.
  const ouRes = resolveOu(department, office, settings);
  const ou = ouRes.ou;
  if (ouRes.isPlaceholder) warnings.push('No target OU is set yet. Set a default OU (plus per-office / per-department OUs) on the Active Directory page before creating the account.');
  else if (ouRes.matched === 'default' && (office || department) && (Object.keys(settings.officeOuMap).length || Object.keys(settings.departmentOuMap).length)) warnings.push(`No OU is mapped for ${department ? `department "${department}"` : `office "${office}"`}; using the default OU. Add a mapping on the Active Directory page to place this hire in the right location.`);

  // The mapped on-prem security groups the hire needs (from the IT group items). SharePoint-group
  // items are listed as a note: SharePoint groups live in SharePoint, not on-prem AD.
  const items = db.prepare(
    `SELECT label FROM onboarding_items WHERE request_id = ? AND owner = 'it' AND kind = 'task' AND status = 'pending'`
  ).all(requestId) as { label: string }[];
  const securityGroups: string[] = [];
  const sharepointGroups: string[] = [];
  for (const it of items) {
    let m = /^Add to security group:\s*(.+)$/.exec(it.label);
    if (m) { securityGroups.push(m[1].trim()); continue; }
    m = /^Add to SharePoint group:\s*(.+)$/.exec(it.label);
    if (m) sharepointGroups.push(m[1].trim());
  }
  const displayName = [first, last].filter(Boolean).join(' ') || request.name;

  return {
    ok: true,
    first: first || sam,
    last,
    displayName,
    sam,
    upn,
    ou,
    ouIsPlaceholder: ouRes.isPlaceholder,
    password: tempPassword(),
    securityGroups,
    sharepointGroups,
    licenseSku: settings.licenseSku,
    warnings,
  };
}

/**
 * Build the New-ADUser + Add-ADGroupMember PowerShell for one onboarding request. Pure generation:
 * it reads the request and its pending IT group items, and writes no state. Regenerating yields a
 * fresh one-time password (the account has not been created yet, so that is safe).
 */
export function buildProvisionScript(requestId: number): ProvisionScript {
  const plan = buildProvisionPlan(requestId);
  if (!plan.ok) return { ok: false, error: plan.error };
  const { first, last, sam, upn, ou, ouIsPlaceholder, password: pw, securityGroups, sharepointGroups, displayName, licenseSku, warnings } = plan;

  // Confirm each security group name is one we recognise from the catalog, so a typo shows up.
  const knownGroups = new Set(catalogByKind('printer').map((p) => p.group_name).filter(Boolean) as string[]);

  const psq = (s: string) => `'${String(s).replace(/'/g, "''")}'`; // single-quoted PowerShell literal

  const lines: string[] = [];
  lines.push('# 1st Fire Protection - new-hire Active Directory provisioning');
  lines.push(`# Hire: ${displayName}`);
  lines.push('# Run on a domain controller (or a host with the ActiveDirectory module) as an account');
  lines.push('# that can create users in the target OU. Review the CONFIG block first.');
  lines.push('');
  lines.push('Import-Module ActiveDirectory');
  lines.push('');
  lines.push('# ---- CONFIG: verify before running ----');
  lines.push(`$TargetOU     = ${psq(ou)}${ouIsPlaceholder ? '   # PLACEHOLDER - set the real OU distinguished name' : ''}`);
  lines.push(`$TempPassword = ${psq(pw)}   # one-time; the hire must change it at first sign-in`);
  lines.push('');
  lines.push('# ---- The new hire ----');
  lines.push(`$First = ${psq(first || sam)}`);
  lines.push(`$Last  = ${psq(last)}`);
  lines.push(`$Sam   = ${psq(sam)}`);
  lines.push(`$Upn   = ${psq(upn)}`);
  lines.push('');
  lines.push('if (Get-ADUser -Filter "SamAccountName -eq \'$Sam\'" -ErrorAction SilentlyContinue) {');
  lines.push('  Write-Warning "$Sam already exists in AD. Stopping so nothing is overwritten."; return');
  lines.push('}');
  lines.push('');
  lines.push('$pw = ConvertTo-SecureString $TempPassword -AsPlainText -Force');
  lines.push('New-ADUser `');
  lines.push('  -Name "$First $Last" `');
  lines.push('  -GivenName $First `');
  lines.push('  -Surname $Last `');
  lines.push('  -DisplayName "$First $Last" `');
  lines.push('  -SamAccountName $Sam `');
  lines.push('  -UserPrincipalName $Upn `');
  lines.push('  -EmailAddress $Upn `');
  lines.push('  -Path $TargetOU `');
  lines.push('  -AccountPassword $pw `');
  lines.push('  -ChangePasswordAtLogon $true `');
  lines.push('  -Enabled $true');
  lines.push('');

  if (securityGroups.length) {
    lines.push('# ---- On-prem AD security groups (sync up to Entra via Azure AD Connect) ----');
    for (const g of securityGroups) {
      const note = knownGroups.has(g) ? '' : '   # not found in the OS catalog - confirm this group name';
      lines.push(`Add-ADGroupMember -Identity ${psq(g)} -Members $Sam${note}`);
    }
    lines.push('');
  } else {
    lines.push('# ---- No on-prem security groups were requested for this hire. ----');
    lines.push('');
  }

  if (sharepointGroups.length) {
    lines.push('# ---- SharePoint groups (set these in SharePoint, not in AD) ----');
    for (const g of sharepointGroups) lines.push(`#   - ${g}`);
    lines.push('');
  }

  lines.push('# ---- Licensing (cloud-side, after this account syncs to Entra) ----');
  if (licenseSku) lines.push(`# Assign license SKU ${licenseSku} in the M365 admin center or via Graph once the account appears in Entra.`);
  else lines.push('# Assign the new-hire license in the M365 admin center once the account appears in Entra. (Set a default SKU in Integrations to name it here.)');
  lines.push('# Force a sync instead of waiting: Start-ADSyncSyncCycle -PolicyType Delta   (run on the AAD Connect server)');
  lines.push('');
  lines.push('Write-Host "Created $Upn. Temp password set; change-at-logon is on."');

  return {
    ok: true,
    script: lines.join('\n'),
    filename: `provision-${sam || 'new-hire'}.ps1`,
    upn,
    sam,
    securityGroups,
    sharepointGroups,
    warnings,
  };
}
