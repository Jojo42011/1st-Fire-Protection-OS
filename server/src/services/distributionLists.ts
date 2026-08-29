import { getDb } from '../db/index';

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

export interface OfficeStat { office: string; headcount: number; matched: number; needsBackfill: number; noAccount: string[] }
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
  const alias = (code || name.replace(/[^a-z0-9]+/gi, '').toLowerCase()).slice(0, 40) || 'office';
  return { name, alias };
}

export function buildOfficeDlPlan(upnDomain = '1stfpservices.com'): DlPlan {
  const db = getDb();
  // Active employees joined to their AD account (by work email / UPN / stamped sam), with the AD office.
  const rows = db.prepare(
    `SELECT e.legal_first_name AS first, e.legal_last_name AS last, e.work_email AS email,
            TRIM(COALESCE(e.office, '')) AS bamboo_office,
            a.sam AS sam, TRIM(COALESCE(a.office, '')) AS ad_office
       FROM employees e
       LEFT JOIN ad_users a
         ON lower(a.email) = lower(e.work_email)
         OR lower(a.upn)   = lower(e.work_email)
         OR lower(a.sam)   = lower(e.ad_username)
      WHERE e.employment_status NOT IN ('terminated', 'prehire')`
  ).all() as { first: string; last: string; email: string; bamboo_office: string; sam: string | null; ad_office: string }[];

  // Group by BambooHR office.
  const byOffice = new Map<string, { headcount: number; matched: number; needsBackfill: number; noAccount: string[] }>();
  const backfill: string[] = [];
  for (const r of rows) {
    const office = r.bamboo_office;
    if (!office) continue; // skip employees with no office set
    if (!byOffice.has(office)) byOffice.set(office, { headcount: 0, matched: 0, needsBackfill: 0, noAccount: [] });
    const g = byOffice.get(office)!;
    g.headcount++;
    if (!r.sam) { g.noAccount.push(`${r.first || ''} ${r.last || ''}`.trim() || r.email); continue; }
    g.matched++;
    if (r.ad_office !== office) g.needsBackfill++;
    // Always stamp both (idempotent); Company is not mirrored so we can't tell who already has it.
    backfill.push(`Set-ADUser -Identity ${psq(r.sam)} -Office ${psq(office)} -Company ${psq(COMPANY)}`);
  }

  const offices: OfficeStat[] = [...byOffice.entries()]
    .map(([office, g]) => ({ office, headcount: g.headcount, matched: g.matched, needsBackfill: g.needsBackfill, noAccount: g.noAccount }))
    .sort((a, b) => b.headcount - a.headcount);

  // ---- Backfill script (on-prem AD) ----
  const bf: string[] = [];
  bf.push('# Stamp Company + Office on every active employee account, matched to BambooHR, so the');
  bf.push('# distribution-list filters catch existing staff. Run on a domain controller, then force a');
  bf.push('# sync: Start-ADSyncSyncCycle -PolicyType Delta on the AD Connect server. Idempotent.');
  bf.push('Import-Module ActiveDirectory');
  bf.push('');
  bf.push(...backfill);
  const backfillScript = bf.join('\n');

  // ---- DDG creation script (Exchange Online) ----
  const dl: string[] = [];
  dl.push('# Create the office and All Employees distribution lists in Exchange Online. Run once.');
  dl.push('# Dynamic groups evaluate their filter at send time, so they maintain themselves afterward.');
  dl.push('Connect-ExchangeOnline');
  dl.push('');
  dl.push('# ---- All employees ----');
  dl.push(`New-DynamicDistributionGroup -Name "All Employees" -Alias "all-employees" -PrimarySmtpAddress "allemployees@${upnDomain}" -RecipientFilter "Company -eq '${COMPANY}' -and RecipientTypeDetails -eq 'UserMailbox'"`);
  dl.push('');
  dl.push('# ---- Per office ----');
  const usedAlias = new Set<string>(['all-employees']);
  for (const o of offices) {
    let { name, alias } = labelForOffice(o.office);
    while (usedAlias.has(alias)) alias = alias + 'x';
    usedAlias.add(alias);
    const officeLit = o.office.replace(/'/g, "''");
    dl.push(`# ${name}  (${o.headcount} active)`);
    dl.push(`New-DynamicDistributionGroup -Name ${psq(name)} -Alias ${psq(alias)} -PrimarySmtpAddress "${alias}@${upnDomain}" -RecipientFilter "Company -eq '${COMPANY}' -and Office -eq '${officeLit}' -and RecipientTypeDetails -eq 'UserMailbox'"`);
  }
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
