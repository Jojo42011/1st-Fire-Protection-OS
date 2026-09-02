import { computeDrift, DriftFinding, DriftCode } from './adAudit';

/**
 * Turn a hand-picked set of AD audit findings into a single PowerShell script to run ON A DOMAIN
 * CONTROLLER. The operator reviews the findings on the AD page, ticks only the ones they want fixed
 * (leaving shared/service accounts alone), and this emits exactly those fixes: disable a terminated
 * account, strip its groups, or correct a title/mobile. Nothing is written from the server, and the
 * server, not the browser, supplies the target values (title/phone come from the live drift compute),
 * so a tampered request can only ever act on a real, current finding.
 */

// PowerShell single-quoted literal (double any embedded quote).
const psq = (s: string) => `'${String(s || '').replace(/'/g, "''")}'`;

export interface CleanupSelection { sam: string; code: DriftCode }
export interface CleanupScript {
  ok: boolean;
  error?: string;
  filename?: string;
  script?: string;
  count?: number;
  actions?: Record<string, number>;
  skipped?: number;
}

// Human label + the kind of change each finding turns into, so the summary reads plainly.
const ACTION_LABEL: Record<DriftCode, string> = {
  terminated_enabled: 'Disable account',
  terminated_in_groups: 'Remove from all groups',
  orphan_enabled: 'Disable account (no employee match)',
  missing_title: 'Set job title',
  title_mismatch: 'Correct job title',
  missing_mobile: 'Set mobile number',
};

/** Emit the try/catch block that carries out one finding's fix. */
function blockFor(f: DriftFinding): string[] {
  const sam = f.sam as string;
  const L: string[] = [];
  const who = `${f.name || sam} (${sam})`;
  switch (f.code) {
    case 'terminated_enabled':
    case 'orphan_enabled':
      L.push(`# ${who}: disable + scramble the password`);
      L.push('try {');
      L.push(`  $u = Get-ADUser -Identity ${psq(sam)}`);
      L.push('  Disable-ADAccount -Identity $u');
      L.push('  $rnd = -join ((48..57)+(65..90)+(97..122)+(33,35,36,37,38,42) | Get-Random -Count 20 | ForEach-Object { [char]$_ })');
      L.push('  Set-ADAccountPassword -Identity $u -Reset -NewPassword (ConvertTo-SecureString $rnd -AsPlainText -Force)');
      L.push(`  Write-Host "Disabled ${sam.replace(/"/g, '')}"`);
      L.push(`} catch { Write-Warning "Disable ${sam.replace(/"/g, '')} failed: $($_.Exception.Message)" }`);
      break;
    case 'terminated_in_groups':
      L.push(`# ${who}: remove from every security group (primary group is left in place)`);
      L.push('try {');
      L.push(`  $u = Get-ADUser -Identity ${psq(sam)} -Properties MemberOf`);
      L.push('  foreach ($dn in @($u.MemberOf)) { Remove-ADGroupMember -Identity $dn -Members $u -Confirm:$false }');
      L.push(`  Write-Host "Removed ${sam.replace(/"/g, '')} from $(@($u.MemberOf).Count) group(s)"`);
      L.push(`} catch { Write-Warning "Group removal for ${sam.replace(/"/g, '')} failed: $($_.Exception.Message)" }`);
      break;
    case 'missing_title':
    case 'title_mismatch':
      if (!f.expected) return [];
      L.push(`# ${who}: set job title to ${f.expected}`);
      L.push(`try { Set-ADUser -Identity ${psq(sam)} -Title ${psq(f.expected)}; Write-Host "Title set for ${sam.replace(/"/g, '')}" } catch { Write-Warning "Title for ${sam.replace(/"/g, '')} failed: $($_.Exception.Message)" }`);
      break;
    case 'missing_mobile':
      if (!f.expected) return [];
      L.push(`# ${who}: set mobile number to ${f.expected}`);
      L.push(`try { Set-ADUser -Identity ${psq(sam)} -MobilePhone ${psq(f.expected)}; Write-Host "Mobile set for ${sam.replace(/"/g, '')}" } catch { Write-Warning "Mobile for ${sam.replace(/"/g, '')} failed: $($_.Exception.Message)" }`);
      break;
    default:
      return [];
  }
  return L;
}

export function buildAdCleanupScript(selections: CleanupSelection[]): CleanupScript {
  const picked = (selections || []).filter((s) => s && s.sam && s.code);
  if (!picked.length) return { ok: false, error: 'Pick at least one finding to fix.' };

  // Recompute the audit so the fixes come from live findings, not whatever the client sent.
  const { findings } = computeDrift();
  const byKey = new Map<string, DriftFinding>();
  for (const f of findings) if (f.sam) byKey.set(`${String(f.sam).toLowerCase()}::${f.code}`, f);

  const chosen: DriftFinding[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const s of picked) {
    const key = `${s.sam.toLowerCase()}::${s.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = byKey.get(key);
    if (f) chosen.push(f); else skipped++;
  }
  if (!chosen.length) return { ok: false, error: 'None of the selected findings are still current. Refresh the audit and try again.', skipped };

  // Order so account disables come before group strips before attribute edits, and group by account.
  const order: DriftCode[] = ['terminated_enabled', 'orphan_enabled', 'terminated_in_groups', 'title_mismatch', 'missing_title', 'missing_mobile'];
  chosen.sort((a, b) => (order.indexOf(a.code) - order.indexOf(b.code)) || String(a.sam).localeCompare(String(b.sam)));

  const actions: Record<string, number> = {};
  const L: string[] = [];
  L.push('# ------------------------------------------------------------------------');
  L.push('# Active Directory cleanup - RUN ON A DOMAIN CONTROLLER (elevated PowerShell).');
  L.push(`# Generated ${new Date().toISOString()} from ${chosen.length} hand-picked finding(s).`);
  L.push('# Every step is wrapped in try/catch and is safe to re-run. Review before running.');
  L.push('# After disables/group changes, force a sync on the AD Connect server:');
  L.push('#   Start-ADSyncSyncCycle -PolicyType Delta');
  L.push('# ------------------------------------------------------------------------');
  L.push('Import-Module ActiveDirectory');
  L.push('');
  for (const f of chosen) {
    const block = blockFor(f);
    if (!block.length) { skipped++; continue; }
    actions[ACTION_LABEL[f.code]] = (actions[ACTION_LABEL[f.code]] || 0) + 1;
    L.push(...block, '');
  }
  L.push('Write-Host ""');
  L.push(`Write-Host "AD cleanup complete. Run Start-ADSyncSyncCycle -PolicyType Delta on the AD Connect server to push changes to Entra."`);

  return {
    ok: true,
    filename: `ad-cleanup-${new Date().toISOString().slice(0, 10)}.ps1`,
    script: L.join('\n'),
    count: chosen.length,
    actions,
    skipped,
  };
}
