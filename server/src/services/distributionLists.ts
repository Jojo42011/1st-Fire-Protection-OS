import { getDb } from '../db/index';
import { officeCity } from './officeBranding';

/**
 * Office and company-wide distribution lists (Exchange Online dynamic distribution groups).
 *
 * Two artifacts are generated from live data:
 *  1. An on-prem AD backfill (Set-ADUser) that stamps Company + Office on every active employee's
 *     account, matched to BambooHR, so the DDG recipient filters actually catch existing staff.
 *  2. The EXO PowerShell that creates one dynamic distribution group per office plus an All Employees
 *     group. Filters are exact-match on Office (so similarly-named offices stay separate) and Company.
 *
 * Dynamic groups evaluate their filter at send time, so once the attributes are stamped the lists
 * maintain themselves: new hires (whose provisioning already sets Company/Office) flow in, departed
 * staff drop out.
 */

const COMPANY = '1st Fire Protection';

export interface OfficeStat { office: string; headcount: number; matched: number; needsBackfill: number; noAccount: string[]; bambooNames: string[] }
export interface DlPlan {
  ok: boolean;
  company: string;
  offices: OfficeStat[];
  backfillCount: number;
  backfillScript: string;
  ddgScript: string;
}

// PowerShell single-quoted literal (double any embedded quote).
const psq = (s: string) => `'${String(s || '').replace(/'/g, "''")}'`;

/** A friendly name + alias for an office string: drop "1st FP"/"LLC", use the (CODE) as the alias when
 *  present, else slug the name. */
// Offices whose short code isn't in the BambooHR string but which already own their slug address in
// Exchange (so we use their printer-group code instead of the slug).
const ALIAS_OVERRIDE: Record<string, string> = { collegestation: 'cst', lubbock: 'lub' };

function labelForOffice(office: string): { name: string; alias: string } {
  const codeM = /\(([A-Za-z0-9]+)\)\s*$/.exec(office);
  const code = codeM ? codeM[1].toLowerCase() : '';
  let name = office
    .replace(/\([^)]*\)\s*$/, '')          // trailing (CODE)
    .replace(/1st\s*fp/gi, '')             // company prefix
    .replace(/,?\s*LLC\.?/gi, '')          // LLC / LLC.
    .replace(/\s{2,}/g, ' ')
    .replace(/[.,]\s*$/, '')
    .trim();
  if (!name) name = office.trim();
  let alias = (code || name.replace(/[^a-z0-9]+/gi, '').toLowerCase()).slice(0, 40) || 'office';
  if (ALIAS_OVERRIDE[alias]) alias = ALIAS_OVERRIDE[alias];
  return { name, alias };
}

export function buildOfficeDlPlan(upnDomain = '1stfpservices.com'): DlPlan {
  const db = getDb();
  // Build lookup maps over enabled AD accounts, so each employee resolves to at most one account.
  const adUsers = db.prepare(
    `SELECT sam, upn, email, given_name, surname, TRIM(COALESCE(office,'')) AS office FROM ad_users WHERE enabled = 1 AND sam IS NOT NULL`
  ).all() as { sam: string; upn: string | null; email: string | null; given_name: string | null; surname: string | null; office: string }[];
  const byEmail = new Map<string, typeof adUsers[number]>();
  const byUpn = new Map<string, typeof adUsers[number]>();
  const bySam = new Map<string, typeof adUsers[number]>();
  const byName = new Map<string, typeof adUsers[number]>();
  const lc = (s: string | null | undefined) => String(s || '').toLowerCase().trim();
  for (const a of adUsers) {
    if (a.email) byEmail.set(lc(a.email), a);
    if (a.upn) byUpn.set(lc(a.upn), a);
    if (a.sam) bySam.set(lc(a.sam), a);
    if (a.given_name && a.surname) byName.set(lc(a.given_name) + '|' + lc(a.surname), a);
  }
  const emps = db.prepare(
    `SELECT legal_first_name AS first, legal_last_name AS last, work_email AS email, ad_username,
            TRIM(COALESCE(office,'')) AS bamboo_office
       FROM employees WHERE employment_status NOT IN ('terminated', 'prehire')`
  ).all() as { first: string; last: string; email: string | null; ad_username: string | null; bamboo_office: string }[];
  const usedSam = new Set<string>();
  const rows = emps.map((e) => {
    const hit =
      (e.email && (byEmail.get(lc(e.email)) || byUpn.get(lc(e.email)))) ||
      (e.ad_username && bySam.get(lc(e.ad_username))) ||
      byName.get(lc(e.first) + '|' + lc(e.last)) || null;
    // don't map two employees to the same account
    const sam = hit && !usedSam.has(lc(hit.sam)) ? hit.sam : null;
    if (sam) usedSam.add(lc(sam));
    return { first: e.first, last: e.last, email: e.email || '', bamboo_office: e.bamboo_office, sam, ad_office: hit ? hit.office : '' };
  });

  // Group by office city (AD Office holds the city, e.g. "Austin", not the LLC "1st FP Austin, LLC").
  // Each city remembers the BambooHR office names behind it, so its list keeps its existing address
  // and also catches accounts still carrying the old LLC text.
  const byOffice = new Map<string, { headcount: number; matched: number; needsBackfill: number; noAccount: string[]; names: Map<string, number> }>();
  const backfill: string[] = [];
  for (const r of rows) {
    if (!r.bamboo_office) continue; // skip employees with no office set
    const office = officeCity(r.bamboo_office);
    if (!byOffice.has(office)) byOffice.set(office, { headcount: 0, matched: 0, needsBackfill: 0, noAccount: [], names: new Map() });
    const g = byOffice.get(office)!;
    g.headcount++;
    g.names.set(r.bamboo_office, (g.names.get(r.bamboo_office) || 0) + 1);
    if (!r.sam) { g.noAccount.push(`${r.first || ''} ${r.last || ''}`.trim() || r.email); continue; }
    g.matched++;
    if (r.ad_office !== office) g.needsBackfill++;
    // Always stamp both (idempotent); Company is not mirrored so we can't tell who already has it.
    backfill.push(`Set-ADUser -Identity ${psq(r.sam)} -Office ${psq(office)} -Company ${psq(COMPANY)}`);
  }

  const offices: OfficeStat[] = [...byOffice.entries()]
    .map(([office, g]) => ({ office, headcount: g.headcount, matched: g.matched, needsBackfill: g.needsBackfill, noAccount: g.noAccount,
      bambooNames: [...g.names.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n) }))
    .sort((a, b) => b.headcount - a.headcount);

  // ---- Backfill script (on-prem AD) ----
  const bf: string[] = [];
  bf.push('# Stamp Company + Office (the city, e.g. Austin) on every active employee account, matched to BambooHR, so the');
  bf.push('# distribution-list filters catch existing staff. Run on a domain controller, then force a');
  bf.push('# sync: Start-ADSyncSyncCycle -PolicyType Delta on the AD Connect server. Idempotent.');
  bf.push('Import-Module ActiveDirectory');
  bf.push('');
  bf.push(...backfill);
  const backfillScript = bf.join('\n');

  // ---- DDG creation script (Exchange Online) ----
  // Idempotent: renames/updates a list if one already carries the address, else creates it. Every list
  // gets a uniform "<Office> - All Staff" display name so it never collides with an office Team/M365
  // group of the bare name.
  const dl: string[] = [];
  dl.push('# Create/refresh the office + All Employees distribution lists in Exchange Online. Safe to');
  dl.push('# re-run. Dynamic groups evaluate their filter at send time, so they maintain themselves.');
  dl.push('# Each office list matches Office = the city (Austin, San Antonio, ...) and also the old BambooHR');
  dl.push('# LLC text, so it works whether or not fix-ad.ps1 has run yet. Existing lists keep their address');
  dl.push('# and are updated in place (display name becomes "<City> - All Staff").');
  dl.push('# Run from a PC with the Exchange Online module:  Install-Module ExchangeOnlineManagement');
  dl.push('Connect-ExchangeOnline');
  dl.push('');
  dl.push('$offices = @(');
  const usedAlias = new Set<string>(['allemployees']);
  const opathq = (v: string) => `'${v.replace(/'/g, "''")}'`; // OPATH string literal
  for (const o of offices) {
    // Keep the address the list already has: it was derived from the main BambooHR office name.
    let { alias } = labelForOffice(o.bambooNames[0] || o.office);
    while (usedAlias.has(alias)) alias = alias + 'x';
    usedAlias.add(alias);
    const values = [o.office, ...o.bambooNames.filter((n) => n !== o.office)];
    const filter = `Company -eq ${opathq(COMPANY)} -and (${values.map((v) => `Office -eq ${opathq(v)}`).join(' -or ')}) -and RecipientTypeDetails -eq 'UserMailbox'`;
    dl.push(`  @{ Name = ${psq(o.office + ' - All Staff')}; Alias = ${psq(alias)}; Smtp = ${psq(alias + '@' + upnDomain)}; Filter = ${psq(filter)} }`);
  }
  dl.push(')');
  dl.push('');
  dl.push('foreach ($o in $offices) {');
  dl.push('  $filter = $o.Filter');
  dl.push('  $g = Get-DynamicDistributionGroup -Identity $o.Smtp -ErrorAction SilentlyContinue');
  dl.push('  try {');
  dl.push('    if ($g) {');
  dl.push('      Set-DynamicDistributionGroup -Identity $g.Identity -DisplayName $o.Name -RecipientFilter $filter -ErrorAction Stop');
  dl.push('      Write-Host "Updated $($o.Name)"');
  dl.push('    } else {');
  dl.push('      New-DynamicDistributionGroup -Name $o.Name -Alias $o.Alias -PrimarySmtpAddress $o.Smtp -RecipientFilter $filter -ErrorAction Stop | Out-Null');
  dl.push('      Write-Host "Created $($o.Name)"');
  dl.push('    }');
  dl.push('  } catch { Write-Warning "FAILED $($o.Name): $($_.Exception.Message)" }');
  dl.push('}');
  dl.push('');
  dl.push('# ---- All Employees: retire the old static list and move allemployees@ onto the dynamic one ----');
  dl.push(`$staticAll = Get-DistributionGroup -Identity "allemployees@${upnDomain}" -ErrorAction SilentlyContinue`);
  dl.push('if ($staticAll) { Remove-DistributionGroup -Identity $staticAll.Identity -Confirm:$false; Write-Host "Removed static All Employees" }');
  dl.push(`$dynAll = Get-DynamicDistributionGroup -Identity "allemployees-dyn@${upnDomain}" -ErrorAction SilentlyContinue`);
  dl.push("if (-not $dynAll) { $dynAll = Get-DynamicDistributionGroup -ResultSize Unlimited | Where-Object { $_.DisplayName -like 'All Employees*' } | Select-Object -First 1 }");
  dl.push('if ($dynAll) {');
  dl.push(`  Set-DynamicDistributionGroup -Identity $dynAll.Identity -DisplayName "All Employees" -PrimarySmtpAddress "allemployees@${upnDomain}" -RecipientFilter "Company -eq '${COMPANY}' -and RecipientTypeDetails -eq 'UserMailbox'"`);
  dl.push('  Write-Host "All Employees now at allemployees@ (dynamic)"');
  dl.push('} else {');
  dl.push(`  New-DynamicDistributionGroup -Name "All Employees" -Alias "allemployees" -PrimarySmtpAddress "allemployees@${upnDomain}" -RecipientFilter "Company -eq '${COMPANY}' -and RecipientTypeDetails -eq 'UserMailbox'"`);
  dl.push('}');
  const ddgScript = dl.join('\n');

  return {
    ok: true,
    company: COMPANY,
    offices,
    backfillCount: backfill.length,
    backfillScript,
    ddgScript,
  };
}
