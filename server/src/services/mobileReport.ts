/**
 * Phones & iPads executive report: the leadership view of the mobile fleet, computed live from the
 * same lines and Teams audit the Devices screen shows, so the two never disagree. Every dollar figure
 * says whether it is real (plan costs entered) or an estimate (bill total / lines, Teams list price).
 */
import { getState, setState } from '../db/schema';
import { listLines, teamsAudit, LineFlag } from './mobileFleet';
import { teamsVoiceStatus } from './teamsVoice';

/** Teams Phone with Calling Plan, per user per month, until IT enters the real price from the invoice. */
export const DEFAULT_TEAMS_VOICE_COST = 17;

export function teamsVoiceCost(): { cost: number; estimated: boolean } {
  const v = Number(getState('mobile.teams_voice_cost'));
  return Number.isFinite(v) && v > 0 ? { cost: v, estimated: false } : { cost: DEFAULT_TEAMS_VOICE_COST, estimated: true };
}
export function setTeamsVoiceCost(amount: unknown): void {
  const v = amount === '' || amount === null || amount === undefined ? '' : Number(amount);
  if (v !== '' && !(v > 0)) throw new Error('amount must be a positive number');
  setState('mobile.teams_voice_cost', String(v));
}

const round = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: any[], f: (x: any) => number) => round(xs.reduce((s, x) => s + (Number(f(x)) || 0), 0));
const has = (l: any, ...keys: string[]) => l.flags.some((f: LineFlag) => keys.includes(f.key));
const owes = (l: any) => !l.paid_off && Number(l.device_balance) > 0;

export function executiveReport(): any {
  const { lines, summary } = listLines();
  const audit = teamsAudit();
  const tv = teamsVoiceCost();
  const active = lines.filter((l) => l.status !== 'cancelled');
  const costEstimated = summary.monthlyServiceEstimated || active.some((l) => l.cost_source && l.cost_source.startsWith('estimate'));
  const priced = active.filter((l) => l.monthly_cost != null).length;

  // Idle lines: spare, still billing after a cancel request, or held by someone leaving.
  const idle = active.filter((l) => has(l, 'still_billing', 'spare', 'termed_holder', 'freeze_pending'));
  const idleFree = idle.filter((l) => !owes(l));
  const idleOwing = idle.filter(owes);

  // Teams voice: licenses nobody uses (incl. people who also have a cell and use it), and heavy Teams callers.
  const removeTeams = audit.rows.filter((r) => ['unused', 'overlap_unused', 'overlap_light'].includes(r.category));
  const heavy = audit.rows.filter((r) => r.category === 'overlap_heavy');
  const review = audit.rows.filter((r) => r.category === 'overlap');
  const disabled = audit.rows.filter((r) => r.category === 'disabled');
  const heavyLines = active.filter((l) => l.kind === 'phone' && heavy.some((h) => h.phones.includes(l.number_fmt)));

  const actions = [
    { key: 'cancel_free', label: 'Cancel idle lines that are paid off', count: idleFree.length, unit: 'lines', monthly: sum(idleFree, (l) => l.monthly_cost), oneTime: 0 },
    { key: 'cancel_owing', label: 'Cancel idle lines that still owe a device balance', count: idleOwing.length, unit: 'lines', monthly: sum(idleOwing, (l) => l.monthly_cost), oneTime: sum(idleOwing, (l) => l.device_balance) },
    { key: 'remove_teams', label: 'Remove Teams Phone from people who do not use it', count: removeTeams.length, unit: 'licenses', monthly: round(removeTeams.length * tv.cost), oneTime: 0, estimated: tv.estimated },
    { key: 'drop_att_heavy', label: 'Drop the AT&T phone for heavy Teams callers', count: heavyLines.length, unit: 'lines', monthly: sum(heavyLines, (l) => l.monthly_cost), oneTime: sum(heavyLines.filter(owes), (l) => l.device_balance) },
  ].map((a) => ({ ...a, yearly: round(a.monthly * 12) }));
  const total = { monthly: sum(actions, (a) => a.monthly), yearly: sum(actions, (a) => a.yearly), oneTime: sum(actions, (a) => a.oneTime) };

  const offices = Object.keys(summary.byOffice).map((k) => {
    const o = summary.byOffice[k];
    const ls = active.filter((l) => (l.office || '') === k);
    return { key: k, label: o.label, lines: o.lines, phones: o.phones, tablets: o.tablets, monthly: sum(ls, (l) => l.monthly_cost), idle: ls.filter((l) => idle.includes(l)).length };
  }).sort((a, b) => b.lines - a.lines);

  const count = (key: string) => active.filter((l) => has(l, key)).length;
  const risk = [
    { key: 'no_serial', label: 'No serial number on file', count: count('no_serial'), why: 'Cannot be matched in ABM or Addigy until IT records it' },
    { key: 'too_old', label: 'Too old for current iOS', count: count('too_old'), why: 'No security updates; cannot be fully managed' },
    { key: 'imei_mismatch', label: 'A different device in the SIM than AT&T has on file', count: count('imei_mismatch'), why: 'Devices were swapped without a record' },
    { key: 'personal_apple_id', label: 'Personal Apple ID on a company device', count: count('personal_apple_id'), why: 'The company cannot lock or recover the device' },
    { key: 'not_in_mdm', label: 'Not enrolled in Addigy', count: count('not_in_mdm'), why: 'Not managed: no remote lock, wipe or app control' },
    { key: 'termed_holder', label: 'Line held by someone leaving or gone', count: count('termed_holder'), why: 'Recover the device and cancel or reassign the line' },
  ].filter((r) => r.count > 0 || r.key === 'no_serial');

  const tStatus = teamsVoiceStatus();
  const pick = (r: any) => ({ person: r.person, office: r.office, phones: r.phones, pstn_calls: r.pstn_calls, calls: r.calls, category: r.category, recommendation: r.recommendation });
  return {
    ok: true,
    asOf: { att: summary.attReportAt, teams: tStatus?.ok ? tStatus.at : null, teamsPeriod: tStatus?.period || null, teamsUsageRange: tStatus?.ok ? tStatus.usageRange || null : null, teamsPstnRange: tStatus?.ok ? tStatus.pstnRange || null : null, addigy: summary.addigySyncedAt, abm: summary.abmSyncedAt },
    spend: {
      activeLines: summary.activeLines, phones: summary.phones, tablets: summary.tablets, monthlyService: summary.monthlyService,
      costEstimated, priced, billTotal: summary.billTotal, monthlyInstallments: summary.monthlyInstallments, deviceBalance: summary.deviceBalance,
      perLine: summary.activeLines ? round(summary.monthlyService / Math.max(1, active.length)) : null, upgradeEligible: summary.upgradeEligible,
    },
    teamsVoice: { cost: tv.cost, estimated: tv.estimated, synced: audit.synced, holders: tStatus?.voiceUsers ?? null, counts: audit.counts },
    actions, total, offices, risk,
    idleLines: idle.map((l) => ({ number: l.number_fmt, office: l.office_label, model: l.model, holder: l.employee || l.holder_name || null,
      reason: l.flags.filter((f: LineFlag) => ['still_billing', 'spare', 'termed_holder', 'freeze_pending'].includes(f.key)).map((f: LineFlag) => f.label).join('; '),
      monthly: l.monthly_cost, balance: owes(l) ? l.device_balance : 0 }))
      .sort((a, b) => (a.balance ? 1 : 0) - (b.balance ? 1 : 0) || a.office.localeCompare(b.office)),
    teams: { remove: removeTeams.map(pick), heavy: heavy.map(pick), review: review.map(pick), disabled: disabled.map(pick) },
  };
}
