import { graphToken } from './licenseSources';
import { getTopFolderGrants, removeSiteGroupGrant, grantGroupToItem } from './spSiteGroupCleanup';
import { groupKey, refreshCoverage, SHARED_SITE } from './spCoverage';
import { catalogByKind, removeCatalogItem } from './onboardingCatalog';

/**
 * One set of SharePoint folder-permission changes the IT manager asked for (Oct 2026). A person runs
 * it from the SharePoint access page: Preview reports what would change and changes nothing; Apply
 * makes the changes through Microsoft Graph:
 *   - HR no longer opens the 1st FP Houston folder (its direct grant there is removed).
 *   - Payroll opens 1st FP Houston, College Station and Lubbock, at the same level it has on the
 *     other office folders.
 *   - SG-SP-1AutoInsurance and SG-SP-ExternalExtinguishers come off the onboarding form (the groups
 *     themselves are deleted in AD by a person).
 * It also lists who is in SG-SP-Services but not SG-SP-SanAntonio, so Services can be retired without
 * anyone losing the San Antonio folder. Every step is idempotent: a re-run skips what is already done.
 */
const PAYROLL_ADD = ['1st FP Houston', '1st FP College Station', '1st FP Lubbock'];
const RETIRED = /^sg-sp-(1autoinsurance|externalextinguishers)$/i;

async function gjson(url: string, token: string): Promise<any> {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`graph ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
async function groupByName(name: string, token: string): Promise<{ id: string; displayName: string } | null> {
  const j = await gjson(`https://graph.microsoft.com/v1.0/groups?$filter=${encodeURIComponent(`displayName eq '${name}'`)}&$select=id,displayName`, token);
  return (j.value || [])[0] || null;
}
async function members(groupId: string, token: string): Promise<{ name: string; upn: string }[]> {
  const out: { name: string; upn: string }[] = [];
  let url: string | null = `https://graph.microsoft.com/v1.0/groups/${groupId}/members?$select=displayName,userPrincipalName&$top=999`;
  while (url) {
    // eslint-disable-next-line no-await-in-loop
    const j: any = await gjson(url, token);
    for (const m of j.value || []) out.push({ name: m.displayName || '', upn: String(m.userPrincipalName || '').toLowerCase() });
    url = j['@odata.nextLink'] || null;
  }
  return out;
}

export async function applyOct2026SpChanges(apply: boolean, site = SHARED_SITE): Promise<{ ok: boolean; applied: boolean; lines: string[]; servicesOnly: { name: string; upn: string }[] }> {
  const lines: string[] = [];
  const token = await graphToken();
  if (!token) return { ok: false, applied: false, lines: ['Microsoft Graph is not connected.'], servicesOnly: [] };
  const top = await getTopFolderGrants(site);
  if (!top.ok) return { ok: false, applied: false, lines: [`Could not read the folders: ${top.error}`], servicesOnly: [] };
  const byName = new Map(top.folders.map((f) => [f.folder.toLowerCase(), f]));

  // 1) HR off the Houston folder (only its own grant there; an inherited one is reported, not touched).
  const hou = byName.get('1st fp houston');
  if (!hou) lines.push('HR: no "1st FP Houston" folder found, nothing changed.');
  else {
    const hr = hou.grants.filter((g) => g.kind !== 'user' && groupKey(g.name) === 'hr');
    if (!hr.length) lines.push('HR: already has no access to 1st FP Houston.');
    for (const g of hr) {
      if (g.inherited) { lines.push(`HR: its access to 1st FP Houston is inherited from above, so it was not removed here.`); continue; }
      if (!apply) { lines.push(`HR: would be removed from 1st FP Houston (has ${g.roles || 'access'}).`); continue; }
      // eslint-disable-next-line no-await-in-loop
      const r = await removeSiteGroupGrant(hou.driveId, hou.itemId, g.permId);
      lines.push(r.ok ? `HR: removed from 1st FP Houston (was ${g.roles || 'access'}).` : `HR: could not remove from 1st FP Houston: ${r.error}`);
    }
  }

  // 2) Payroll onto Houston, College Station and Lubbock, at the level it has elsewhere.
  const payroll = await groupByName('SG-SP-Payroll', token);
  const sample = top.folders.flatMap((f) => f.grants).find((g) => g.kind !== 'user' && groupKey(g.name) === 'payroll' && !g.inherited);
  const role = sample && /write|owner|edit/i.test(sample.roles) ? 'write' : 'read';
  if (!payroll) lines.push('Payroll: the SG-SP-Payroll group was not found in Entra, nothing granted.');
  else for (const name of PAYROLL_ADD) {
    const f = byName.get(name.toLowerCase());
    if (!f) { lines.push(`Payroll: no "${name}" folder found.`); continue; }
    if (f.grants.some((g) => g.kind !== 'user' && groupKey(g.name) === 'payroll')) { lines.push(`Payroll: already opens ${name}.`); continue; }
    if (!apply) { lines.push(`Payroll: would be added to ${name} (${role === 'write' ? 'edit' : 'read'}, same as its other office folders).`); continue; }
    // eslint-disable-next-line no-await-in-loop
    const r = await grantGroupToItem(f.driveId, f.itemId, payroll.id, token, role);
    lines.push(r.ok ? `Payroll: added to ${name} (${role === 'write' ? 'edit' : 'read'}, same as its other office folders).` : `Payroll: could not add to ${name}: ${r.error}`);
  }

  // 3) The two unused groups come off the onboarding form.
  for (const c of catalogByKind('sharepoint')) {
    if (RETIRED.test(c.name)) { if (apply) removeCatalogItem(c.id); lines.push(`Form: ${c.name} ${apply ? 'is no longer offered' : 'would no longer be offered'}.`); }
  }

  // 4) Who would lose San Antonio if Services is deleted today.
  let servicesOnly: { name: string; upn: string }[] = [];
  try {
    const [sa, sv] = await Promise.all([groupByName('SG-SP-SanAntonio', token), groupByName('SG-SP-Services', token)]);
    if (sa && sv) {
      const inSa = new Set((await members(sa.id, token)).map((m) => m.upn));
      const svm = await members(sv.id, token);
      servicesOnly = svm.filter((m) => !inSa.has(m.upn));
      lines.push(`San Antonio vs Services: SG-SP-Services has ${svm.length} member(s), ${servicesOnly.length} of them not in SG-SP-SanAntonio.`);
    }
  } catch (e) { lines.push(`Could not compare San Antonio and Services members: ${(e as Error).message}`); }

  if (apply) {
    const cov = await refreshCoverage(site);
    lines.push(cov.ok ? 'Coverage re-read, so the onboarding form uses the new permissions.' : `Coverage not re-read: ${cov.error}`);
  }
  return { ok: true, applied: apply, lines, servicesOnly };
}

export function changesReportHtml(r: { applied: boolean; lines: string[]; servicesOnly: { name: string; upn: string }[] }): string {
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const move = r.servicesOnly.length
    ? `<p style="margin:16px 0 6px"><b>Before deleting SG-SP-Services</b>, add these ${r.servicesOnly.length} people to SG-SP-SanAntonio so they keep the San Antonio folder:</p>
       <ul style="margin:0 0 10px;padding-left:20px">${r.servicesOnly.map((m) => `<li>${esc(m.name)} (${esc(m.upn)})</li>`).join('')}</ul>`
    : '<p style="margin:16px 0 6px">Everyone in SG-SP-Services is already in SG-SP-SanAntonio, so it can be deleted as is.</p>';
  const script = [
    '# On a domain controller. Preview first (-WhatIf), then run again without it.',
    ...r.servicesOnly.map((m) => `Add-ADGroupMember -Identity 'SG-SP-SanAntonio' -Members (Get-ADUser -Filter "UserPrincipalName -eq ${ps(m.upn)}") -WhatIf`),
    "Remove-ADGroup -Identity 'SG-SP-Services' -Confirm:$false -WhatIf",
    "Remove-ADGroup -Identity 'SG-SP-1AutoInsurance' -Confirm:$false -WhatIf",
    "Remove-ADGroup -Identity 'SG-SP-ExternalExtinguishers' -Confirm:$false -WhatIf",
    '# Then on the Entra Connect server:  Start-ADSyncSyncCycle -PolicyType Delta',
  ].join('\n');
  return `<div style="font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;color:#1d1d1f;max-width:760px;font-size:14px;line-height:1.55">
  <p style="font-size:20px;font-weight:800;margin:0 0 8px">SharePoint permission changes: ${r.applied ? 'done' : 'preview (nothing changed yet)'}</p>
  <ul style="margin:0 0 8px;padding-left:20px">${r.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  ${move}
  <p style="margin:16px 0 6px"><b>Deleting the three groups in AD</b> (SG-SP-Services, SG-SP-1AutoInsurance, SG-SP-ExternalExtinguishers):</p>
  <pre style="background:#f5f5f7;border-radius:12px;padding:12px 14px;font-size:12px;white-space:pre-wrap">${esc(script)}</pre>
  <p style="font-size:12px;color:#86868b">1Auto Insurance and External Extinguishers opened no top-level folder; if they were granted on a deeper folder, deleting them removes that access too.</p>
</div>`;
}
