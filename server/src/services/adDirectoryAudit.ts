import { getDb } from '../db/index';
import { canonicalOffice, officeLabel, knownOffices } from '../os/office';
import { officeBranding } from './officeBranding';
import { getAdSettings, resolveOu } from './adProvision';
import { lastSync, buildEmployeeIndex, matchAdToEmployee, EmpRow } from './adAudit';

/**
 * AD directory audit for the email signature and OU placement (read-only).
 *
 * The signature tool reads AD fields, so each active person should carry:
 *   Title     = their job title (BambooHR is authoritative)
 *   Telephone = their office's main number (the branch line from 1stfpservices.com/contact)
 *   Mobile    = their cell from BambooHR, or a Teams voice number set by hand
 * and sit in the OU for their office. This compares the AD mirror against BambooHR and reports what is
 * off. It writes nothing; the generated PowerShell is reviewed and run by a person on a DC, and it
 * never moves accounts between OUs (a move can take someone out of Entra Connect's sync scope).
 */

const DOMAIN_LOGON_DAYS = 90;
const lc = (v: string | null | undefined) => String(v || '').trim().toLowerCase();
const digits = (v: string | null | undefined) => String(v || '').replace(/\D/g, '');
const psq = (v: string) => `'${String(v || '').replace(/'/g, "''")}'`;

/** 2103773473 / (210) 377-3473 / +1 210 377 3473 -> 210-377-3473. Anything else is returned trimmed. */
export function formatPhone(v: string | null | undefined): string {
  const d = digits(v);
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : String(v || '').trim();
}
const samePhone = (a: string | null | undefined, b: string | null | undefined) => {
  const x = digits(a).slice(-10), y = digits(b).slice(-10);
  return !!x && x === y;
};

const OFFICE_KEYS = new Set(knownOffices().map((o) => o.key));
/** The office an OU stands for: the nearest OU name (leaf first) that is a known office, else null. */
export function ouOffice(ouDn: string | null | undefined): string | null {
  const parts = String(ouDn || '').split(/(?<!\\),/).map((p) => p.trim());
  for (const p of parts) {
    const m = /^OU=(.+)$/i.exec(p);
    if (!m) continue;
    const k = canonicalOffice(m[1]);
    if (k && OFFICE_KEYS.has(k)) return k;
  }
  return null;
}
/** The account sits in a default container (CN=Users) or the domain root, not an OU of its own. */
function inDefaultContainer(ouDn: string | null | undefined): boolean {
  const first = String(ouDn || '').split(/(?<!\\),/)[0].trim();
  return !first || /^CN=/i.test(first) || /^DC=/i.test(first);
}
/** "OU=Users,OU=Austin,DC=corp,DC=local" -> "Austin / Users" */
export function ouLabel(ouDn: string | null | undefined): string {
  const names = String(ouDn || '').split(/(?<!\\),/).map((p) => p.trim()).filter((p) => /^(OU|CN)=/i.test(p)).map((p) => p.replace(/^(OU|CN)=/i, ''));
  return names.length ? names.reverse().join(' / ') : '(domain root)';
}

export interface PersonRow {
  name: string; sam: string | null; upn: string | null; office: string; officeLabel: string;
  ou: string | null; ouLabel: string; ouOffice: string | null;
  placement: 'ok' | 'wrong_office' | 'not_mapped_ou' | 'default_container' | 'unknown';
  expectedOu: string | null; placementNote: string | null;
  title: { current: string | null; expected: string | null; ok: boolean };
  telephone: { current: string | null; expected: string; ok: boolean; collected: boolean };
  mobile: { current: string | null; bamboo: string | null; status: 'ok' | 'empty_fill' | 'empty_none' | 'differs' | 'set_no_bamboo' };
  description: { current: string | null; suggested: string };
  lastDomainLogon: string | null;
}

export interface DirectoryAudit {
  lastSync: ReturnType<typeof lastSync>;
  telephoneCollected: boolean;
  people: PersonRow[];
  counts: Record<string, number>;
  ouComposition: { ou: string; label: string; ouOffice: string | null; total: number; byOffice: { office: string; label: string; count: number }[] }[];
  unmatchedEnabled: { name: string; sam: string | null; ou: string | null; ouLabel: string }[];
  disabledOutsideDisabledOu: { name: string; sam: string | null; ouLabel: string }[];
  script: string;
}

/** Match AD accounts to active employees (UPN, email, sAM, then first + last name). */
function pairs(): { a: any; e: EmpRow }[] & { unmatched?: any[] } {
  const db = getDb();
  const ad = db.prepare(`SELECT * FROM ad_users`).all() as any[];
  const idx = buildEmployeeIndex();
  const byName = new Map<string, EmpRow>();
  for (const e of idx.all) if (e.legal_first_name && e.legal_last_name) byName.set(lc(e.legal_first_name) + '|' + lc(e.legal_last_name), e);
  const out: { a: any; e: EmpRow }[] & { unmatched?: any[] } = [];
  out.unmatched = [];
  const used = new Set<number>();
  for (const a of ad) {
    let e = matchAdToEmployee(a, idx);
    if (!e && a.given_name && a.surname) e = byName.get(lc(a.given_name) + '|' + lc(a.surname));
    if (e && !used.has(e.id)) { used.add(e.id); out.push({ a, e }); } else out.unmatched!.push(a);
  }
  return out;
}

export function directoryAudit(now = new Date()): DirectoryAudit {
  const settings = getAdSettings();
  const mapped = Object.keys(settings.officeOuMap).length > 0 || Object.keys(settings.departmentOuMap).length > 0;
  const all = pairs();
  const active = all.filter(({ e }) => !['terminated', 'prehire'].includes(lc(e.employment_status)));
  const telephoneCollected = (getDb().prepare(`SELECT COUNT(*) AS c FROM ad_users WHERE telephone IS NOT NULL OR description IS NOT NULL`).get() as { c: number }).c > 0;

  // Where most people of each office sit, to suggest a target OU for someone in the wrong one.
  const homeOu = new Map<string, Map<string, number>>();
  for (const { a, e } of active) {
    if (!a.enabled) continue;
    const off = canonicalOffice(e.office);
    if (!off || ouOffice(a.ou) !== off) continue;
    const m = homeOu.get(off) || new Map<string, number>();
    m.set(a.ou, (m.get(a.ou) || 0) + 1); homeOu.set(off, m);
  }
  const suggestOu = (off: string): string | null => {
    const m = homeOu.get(off); if (!m) return null;
    return [...m.entries()].sort((x, y) => y[1] - x[1])[0][0];
  };

  const cutoff = now.getTime() - DOMAIN_LOGON_DAYS * 86400000;
  const people: PersonRow[] = [];
  const scriptLines: string[] = [];
  const moveLines: string[] = [];
  for (const { a, e } of active) {
    if (!a.enabled) continue;
    const off = canonicalOffice(e.office);
    const name = a.display_name || `${e.legal_first_name || ''} ${e.legal_last_name || ''}`.trim();
    const oo = ouOffice(a.ou);
    let placement: PersonRow['placement'] = 'ok', expectedOu: string | null = null, note: string | null = null;
    const res = mapped ? resolveOu(e.department, e.office, settings) : null;
    if (inDefaultContainer(a.ou)) {
      placement = 'default_container'; expectedOu = (res && res.matched !== 'default' ? res.ou : null) || (off ? suggestOu(off) : null);
      note = 'In the default Users container, not an office OU.';
    } else if (res && res.matched !== 'default' && lc(res.ou) !== lc(a.ou)) {
      placement = 'not_mapped_ou'; expectedOu = res.ou;
      note = `The OU mapping on the Active Directory page puts ${res.matched === 'department' ? `department "${e.department}"` : `office "${e.office}"`} somewhere else.`;
    } else if (oo && off && oo !== off) {
      placement = 'wrong_office'; expectedOu = suggestOu(off);
      note = `OU is for ${officeLabel(oo)}, BambooHR says ${officeLabel(off)}.`;
    } else if (!oo) {
      placement = 'unknown';
    }
    const wantTitle = e.public_job_title || e.job_position || null;
    const wantTel = officeBranding(e.office || '').phone;
    const bamboo = e.personal_phone ? formatPhone(e.personal_phone) : null;
    const mobileStatus: PersonRow['mobile']['status'] = a.mobile
      ? (bamboo ? (samePhone(a.mobile, bamboo) ? 'ok' : 'differs') : 'set_no_bamboo')
      : (bamboo ? 'empty_fill' : 'empty_none');
    const logon = a.last_logon ? Date.parse(a.last_logon) : NaN;
    const domainUser = isFinite(logon) && logon >= cutoff;
    people.push({
      name, sam: a.sam, upn: a.upn, office: off, officeLabel: off ? officeLabel(off) : 'No office in BambooHR',
      ou: a.ou, ouLabel: ouLabel(a.ou), ouOffice: oo, placement, expectedOu, placementNote: note,
      title: { current: a.title || null, expected: wantTitle, ok: !wantTitle || lc(a.title) === lc(wantTitle) },
      telephone: { current: a.telephone || null, expected: wantTel, ok: samePhone(a.telephone, wantTel), collected: telephoneCollected },
      mobile: { current: a.mobile || null, bamboo, status: mobileStatus },
      description: { current: a.description || null, suggested: domainUser ? 'AD + Email' : 'Email Only' },
      lastDomainLogon: a.last_logon || null,
    });
    if (a.sam) {
      const sets: string[] = [];
      if (!samePhone(a.telephone, wantTel)) sets.push(`-OfficePhone ${psq(wantTel)}`);
      if (mobileStatus === 'empty_fill' && bamboo) sets.push(`-MobilePhone ${psq(bamboo)}`);
      if (sets.length) scriptLines.push(`Set-ADUser -Identity ${psq(a.sam)} ${sets.join(' ')} -WhatIf:$preview  # ${name}, ${off ? officeLabel(off) : 'no office'}`);
      if ((placement === 'wrong_office' || placement === 'default_container' || placement === 'not_mapped_ou') && expectedOu) {
        moveLines.push(`# Get-ADUser ${psq(a.sam)} | Move-ADObject -TargetPath ${psq(expectedOu)} -WhatIf:$preview  # ${name}: ${ouLabel(a.ou)} -> ${ouLabel(expectedOu)}`);
      }
    }
  }
  const rank: Record<string, number> = { default_container: 0, wrong_office: 1, not_mapped_ou: 2, unknown: 3, ok: 4 };
  people.sort((x, y) => rank[x.placement] - rank[y.placement] || x.officeLabel.localeCompare(y.officeLabel) || x.name.localeCompare(y.name));

  // What each OU holds, by BambooHR office.
  const comp = new Map<string, Map<string, number>>();
  for (const p of people) {
    const m = comp.get(p.ou || '') || new Map<string, number>();
    m.set(p.office, (m.get(p.office) || 0) + 1); comp.set(p.ou || '', m);
  }
  const ouComposition = [...comp.entries()].map(([ou, m]) => ({
    ou, label: ouLabel(ou), ouOffice: ouOffice(ou),
    total: [...m.values()].reduce((s, n) => s + n, 0),
    byOffice: [...m.entries()].map(([office, count]) => ({ office, label: office ? officeLabel(office) : 'No office', count })).sort((x, y) => y.count - x.count),
  })).sort((x, y) => x.label.localeCompare(y.label));

  const unmatchedEnabled = (all.unmatched || []).filter((a) => a.enabled).map((a) => ({ name: a.display_name || a.sam, sam: a.sam, ou: a.ou, ouLabel: ouLabel(a.ou) }))
    .sort((x, y) => String(x.name).localeCompare(String(y.name)));
  const disabledOu = lc(settings.disabledOu || '');
  const disabledOutsideDisabledOu = disabledOu
    ? (getDb().prepare(`SELECT display_name, sam, ou FROM ad_users WHERE enabled = 0`).all() as any[])
        .filter((a) => lc(a.ou) !== disabledOu).map((a) => ({ name: a.display_name || a.sam, sam: a.sam, ouLabel: ouLabel(a.ou) }))
    : [];

  const counts: Record<string, number> = {
    active: people.length,
    wrong_office: people.filter((p) => p.placement === 'wrong_office').length,
    default_container: people.filter((p) => p.placement === 'default_container').length,
    not_mapped_ou: people.filter((p) => p.placement === 'not_mapped_ou').length,
    unknown_ou: people.filter((p) => p.placement === 'unknown').length,
    title_off: people.filter((p) => !p.title.ok).length,
    telephone_off: people.filter((p) => !p.telephone.ok).length,
    mobile_fill: people.filter((p) => p.mobile.status === 'empty_fill').length,
    mobile_none: people.filter((p) => p.mobile.status === 'empty_none').length,
    mobile_differs: people.filter((p) => p.mobile.status === 'differs').length,
    unmatched_enabled: unmatchedEnabled.length,
    disabled_outside: disabledOutsideDisabledOu.length,
  };

  const script = [
    '# Signature fields for every active employee, matched to BambooHR. Generated by the 1st FP OS.',
    '#   Telephone (OfficePhone) = the office main number.',
    '#   Mobile = the BambooHR cell, ONLY where Mobile is empty today (a number already there may be a',
    '#   Teams voice number, so it is never overwritten).',
    '# Runs as a preview by default. Review the output, then run again with -Apply. Afterwards, sync:',
    '#   Start-ADSyncSyncCycle -PolicyType Delta   (on the Entra Connect server)',
    'param([switch]$Apply)',
    'Import-Module ActiveDirectory',
    '$preview = -not $Apply',
    '',
    ...(scriptLines.length ? scriptLines : ['# Nothing to change: every active account already has the right Telephone and Mobile.']),
    '',
    '# ---- OU moves: NOT run by this script (every line is commented out). ----',
    '# Moving a user can take them out of Entra Connect sync scope, which deletes their Microsoft 365',
    '# account, and can change which GPOs apply. Check the target OU is in sync scope first, then',
    '# uncomment the lines you want.',
    ...(moveLines.length ? moveLines : ['# No moves suggested.']),
    '',
  ].join('\r\n');

  return { lastSync: lastSync(), telephoneCollected, people, counts, ouComposition, unmatchedEnabled, disabledOutsideDisabledOu, script };
}

/* ─────────── the emailed report ─────────── */
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export function directoryAuditHtml(d: DirectoryAudit, base: string): string {
  const th = 'text-align:left;padding:6px 8px;border-bottom:1px solid #d2d2d7;font-size:11px;color:#6e6e73;text-transform:uppercase;letter-spacing:.04em';
  const td = 'padding:6px 8px;border-bottom:1px solid #e8e8ed;font-size:13px;vertical-align:top';
  const table = (head: string[], rows: string[][]) => rows.length
    ? `<table style="border-collapse:collapse;width:100%;margin:6px 0 14px"><tr>${head.map((h) => `<th style="${th}">${esc(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td style="${td}">${c}</td>`).join('')}</tr>`).join('')}</table>`
    : '<p style="color:#1a8a4a;font-size:13px;margin:6px 0 14px">None.</p>';
  const h = (t: string) => `<h3 style="font-size:16px;margin:22px 0 4px">${esc(t)}</h3>`;
  const c = d.counts;
  const misplaced = d.people.filter((p) => p.placement === 'wrong_office' || p.placement === 'default_container' || p.placement === 'not_mapped_ou');
  const sync = d.lastSync ? `AD data from the domain controller agent, collected ${esc((d.lastSync.collectedAt || d.lastSync.at || '').slice(0, 16).replace('T', ' '))} UTC (${d.lastSync.users} accounts).` : 'No AD data yet: the domain controller agent has not posted an inventory.';
  return `<div style="font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;color:#1d1d1f;max-width:900px">
  <p style="font-size:20px;font-weight:800;margin:0 0 4px">AD audit: OU placement and signature fields</p>
  <p style="font-size:13px;color:#6e6e73;margin:0">${sync} Compared against BambooHR for ${c.active} active people with an enabled account.</p>
  <table style="border-collapse:collapse;margin:14px 0"><tr>${[
    ['In the wrong office OU', c.wrong_office], ['In the default Users container', c.default_container], ['OU not recognized as an office', c.unknown_ou],
    ['Title differs from BambooHR', c.title_off], ['Telephone not the office main line', c.telephone_off], ['Mobile empty, BambooHR has a cell', c.mobile_fill],
    ['No cell anywhere (needs Teams number?)', c.mobile_none], ['Enabled accounts not matched to anyone', c.unmatched_enabled],
  ].map(([l, n]) => `<td style="padding:8px 14px 8px 0;vertical-align:top"><div style="font-size:22px;font-weight:800;color:${Number(n) ? '#d62d2a' : '#1a8a4a'}">${n}</div><div style="font-size:11.5px;color:#6e6e73;max-width:120px">${esc(l)}</div></td>`).join('')}</tr></table>

  ${h(`People in the wrong OU (${misplaced.length})`)}
  ${table(['Person', 'BambooHR office', 'Current OU', 'Suggested OU', 'Why'], misplaced.map((p) => [esc(p.name), esc(p.officeLabel), esc(p.ouLabel), p.expectedOu ? esc(ouLabel(p.expectedOu)) : '<span style="color:#a15c00">No OU for this office yet</span>', esc(p.placementNote || '')]))}

  ${h('What each OU holds (by BambooHR office)')}
  <p style="font-size:12.5px;color:#6e6e73;margin:0">An OU whose name is an office should only hold that office's people. Mixed rows are where the misplaced accounts are.</p>
  ${table(['OU', 'OU is for', 'People', 'BambooHR offices inside'], d.ouComposition.map((o) => [esc(o.label), o.ouOffice ? esc(officeLabel(o.ouOffice)) : '<span style="color:#86868b">not an office</span>', String(o.total), o.byOffice.map((b) => `${esc(b.label)} ${b.count}`).join(', ')]))}

  ${h(`OU not recognized as an office (${c.unknown_ou})`)}
  <p style="font-size:12.5px;color:#6e6e73;margin:0">These sit in an OU whose name is not an office (for example a department OU), so the audit cannot say if it is right.</p>
  ${table(['Person', 'BambooHR office', 'Current OU'], d.people.filter((p) => p.placement === 'unknown').map((p) => [esc(p.name), esc(p.officeLabel), esc(p.ouLabel)]))}

  ${h('Signature fields')}
  ${table(['Person', 'Office', 'Title (AD / BambooHR)', 'Telephone (now / should be)', 'Mobile (AD / BambooHR)'],
    d.people.filter((p) => !p.title.ok || !p.telephone.ok || p.mobile.status !== 'ok').map((p) => [
      esc(p.name), esc(p.officeLabel),
      p.title.ok ? '<span style="color:#1a8a4a">ok</span>' : `${esc(p.title.current || '(blank)')} / <b>${esc(p.title.expected || '')}</b>`,
      p.telephone.ok ? '<span style="color:#1a8a4a">ok</span>' : `${esc(p.telephone.collected ? (p.telephone.current || '(blank)') : '(not read yet)')} / <b>${esc(p.telephone.expected)}</b>`,
      p.mobile.status === 'ok' ? '<span style="color:#1a8a4a">ok</span>'
        : p.mobile.status === 'empty_fill' ? `(blank) / <b>${esc(p.mobile.bamboo)}</b>`
        : p.mobile.status === 'empty_none' ? '<span style="color:#a15c00">no cell on file: add one or a Teams number</span>'
        : p.mobile.status === 'differs' ? `${esc(p.mobile.current)} / ${esc(p.mobile.bamboo)} <span style="color:#86868b">(Teams number? left alone)</span>`
        : `${esc(p.mobile.current)} / (none) <span style="color:#86868b">left alone</span>`,
    ]))}

  ${h(`Enabled AD accounts not matched to anyone in BambooHR (${d.unmatchedEnabled.length})`)}
  <p style="font-size:12.5px;color:#6e6e73;margin:0">Shared mailboxes, service accounts, or people who left. Worth a look.</p>
  ${table(['Account', 'sAM', 'OU'], d.unmatchedEnabled.map((u) => [esc(u.name), esc(u.sam || ''), esc(u.ouLabel)]))}

  <p style="font-size:13px;margin-top:20px">The fix script for Telephone and Mobile is on the Active Directory page in the OS: <a href="${esc(base.replace(/\/$/, ''))}/?tab=adAudit">open it</a> and use "Download signature fields .ps1". It runs as a preview until you add -Apply, it never overwrites a Mobile that is already set, and the OU moves in it are commented out.</p>
  ${d.telephoneCollected ? '' : '<p style="font-size:13px;color:#a15c00">The Telephone and Description columns show "not read yet" because the agent on the domain controller is an older copy. Replace collect-ad-inventory.ps1 on the DC with the new one from the repo and they will fill in on the next run.</p>'}
</div>`;
}
