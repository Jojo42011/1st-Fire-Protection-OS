import { getDb } from '../db/index';

/**
 * Reconcile enabled AD accounts against BambooHR (the source of truth for who is employed).
 *
 * AD "enabled" is not proof of employment: a leaver whose account was never disabled still shows
 * enabled. So we pair every enabled AD user to a BambooHR person using smart matching (email, sam,
 * and legal OR preferred name with suffix/punctuation stripped, plus a small nickname map), then read
 * BambooHR's employment_status. That surfaces three problems at once:
 *
 *   - offboardingDebt: enabled AD account whose BambooHR record is terminated (should be disabled).
 *   - noBambooMatch:   enabled AD account with no BambooHR person at all (service/contractor/stale).
 *   - missingAccount:  active BambooHR employee with no enabled AD account (needs one / pairing fix).
 *   - active:          enabled AD account tied to an active BambooHR employee (correct).
 *
 * "Active" here means any employment_status that is not terminated/prehire.
 */

const ACTIVE = new Set(['active', 'onboarding', 'notice', 'offboarding']);
const isActive = (s: string) => ACTIVE.has(String(s || '').toLowerCase());

// Modest bidirectional nickname map for the residual cases preferred_name does not already cover.
const NICK: Record<string, string[]> = {
  michael: ['mike', 'mikey'], mike: ['michael'],
  robert: ['rob', 'bob', 'bobby'], rob: ['robert'], bob: ['robert'],
  leonardo: ['leo'], leo: ['leonardo'],
  christopher: ['chris'], chris: ['christopher'],
  anthony: ['tony'], antonio: ['tony'], tony: ['anthony', 'antonio'],
  rodrigo: ['rigo'], rigo: ['rodrigo'],
  donald: ['donnie', 'don'], donnie: ['donald'],
  daniel: ['dan', 'danny'], dan: ['daniel'],
  joseph: ['joe', 'joey'], joe: ['joseph'],
  william: ['will', 'bill', 'billy'], will: ['william'],
  richard: ['rick', 'rich', 'ricky'], rick: ['richard'],
  james: ['jim', 'jimmy'], jim: ['james'],
  jonathan: ['jon', 'john'], jon: ['jonathan'],
  francisco: ['frank', 'paco'], frank: ['francisco'],
  gregory: ['greg'], greg: ['gregory'],
  matthew: ['matt'], matt: ['matthew'],
  nicholas: ['nick'], nick: ['nicholas'],
  edgar: ['ed'], luke: ['lucas'], lucas: ['luke'],
};

const lc = (s: string | null | undefined) => String(s || '').toLowerCase().trim();
// Strip a trailing generational suffix and punctuation from a surname/name token.
const stripSuffix = (s: string) =>
  lc(s).replace(/[.,]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim();
const firstTok = (s: string) => lc(s).replace(/[.,]/g, ' ').trim().split(/\s+/)[0] || '';

export interface ReconRow { name: string; upn: string | null; sam: string | null; office?: string | null; bambooStatus?: string; bambooName?: string }
export interface ReconResult {
  ok: boolean;
  counts: { enabledAd: number; activeBamboo: number; active: number; offboardingDebt: number; noBambooMatch: number; missingAccount: number };
  offboardingDebt: ReconRow[];
  noBambooMatch: ReconRow[];
  missingAccount: ReconRow[];
}

export function reconcileBambooAd(): ReconResult {
  const db = getDb();
  const emps = db.prepare(
    `SELECT legal_first_name AS lf, legal_last_name AS ll, preferred_name AS pref, work_email AS email,
            ad_username AS sam, employment_status AS status
       FROM employees`
  ).all() as { lf: string; ll: string; pref: string | null; email: string | null; sam: string | null; status: string }[];

  // Index employees by every key we might match on.
  const byEmail = new Map<string, typeof emps[number]>();
  const bySam = new Map<string, typeof emps[number]>();
  const byName = new Map<string, typeof emps[number]>();
  const addName = (first: string, lastStripped: string, e: typeof emps[number]) => {
    const f = firstTok(first);
    if (!f || !lastStripped) return;
    for (const variant of new Set([f, ...(NICK[f] || [])])) byName.set(`${variant}|${lastStripped}`, e);
  };
  for (const e of emps) {
    if (e.email) byEmail.set(lc(e.email), e);
    if (e.sam) bySam.set(lc(e.sam), e);
    const last = stripSuffix(e.ll);
    addName(e.lf, last, e);
    if (e.pref) addName(e.pref, last, e);
  }

  const matchEmp = (ad: { email: string | null; upn: string | null; sam: string | null; given: string | null; surname: string | null }): typeof emps[number] | null => {
    if (ad.email && byEmail.get(lc(ad.email))) return byEmail.get(lc(ad.email))!;
    if (ad.upn && byEmail.get(lc(ad.upn))) return byEmail.get(lc(ad.upn))!;
    if (ad.sam && bySam.get(lc(ad.sam))) return bySam.get(lc(ad.sam))!;
    const last = stripSuffix(ad.surname || '');
    const f = firstTok(ad.given || '');
    for (const variant of new Set([f, ...(NICK[f] || [])])) {
      const hit = byName.get(`${variant}|${last}`);
      if (hit) return hit;
    }
    return null;
  };

  const adUsers = db.prepare(
    `SELECT sam, upn, email, given_name AS given, surname, display_name AS dn
       FROM ad_users WHERE enabled = 1 AND sam IS NOT NULL AND sam != ''`
  ).all() as { sam: string; upn: string | null; email: string | null; given: string | null; surname: string | null; dn: string | null }[];

  // Only look at accounts that resemble a person (skip shared mailboxes / rooms / service / admin).
  const NONPERSON = /^(accounting|hr|it|info|jobs|payroll|safety|scans|frontdesk|maintenance|estimating|migration|admin|emergencyadmin|ldap|prtgadmin|test.?user|svc-|.*reception|.*conference|.*conferenceroom|afterhours|ahcf|.*forwarding|.*externalforward|1fp\.connect|1stfp)/i;
  const isPerson = (u: typeof adUsers[number]) => {
    const local = (u.upn || u.email || u.sam || '').split('@')[0];
    if (NONPERSON.test(local)) return false;
    if (/#ext#/i.test(u.upn || '')) return false;
    if (/onmicrosoft\.com$/i.test(u.upn || '')) return false;
    if (/[.-]a$/i.test(local)) return false; // admin alt accounts like booker-a
    return true;
  };

  const offboardingDebt: ReconRow[] = [];
  const noBambooMatch: ReconRow[] = [];
  const matchedEmp = new Set<typeof emps[number]>();
  let activeCount = 0;
  for (const u of adUsers) {
    if (!isPerson(u)) continue;
    const e = matchEmp(u);
    const row: ReconRow = { name: u.dn || `${u.given || ''} ${u.surname || ''}`.trim(), upn: u.upn, sam: u.sam };
    if (!e) { noBambooMatch.push(row); continue; }
    matchedEmp.add(e);
    if (isActive(e.status)) { activeCount++; continue; }
    row.bambooStatus = e.status;
    row.bambooName = `${e.pref || e.lf || ''} ${e.ll || ''}`.trim();
    offboardingDebt.push(row);
  }

  // Active BambooHR employees with no enabled AD account matched.
  const missingAccount: ReconRow[] = [];
  for (const e of emps) {
    if (!isActive(e.status)) continue;
    if (matchedEmp.has(e)) continue;
    missingAccount.push({ name: `${e.pref || e.lf || ''} ${e.ll || ''}`.trim(), upn: e.email || null, sam: e.sam || null, bambooStatus: e.status });
  }

  const activeBamboo = emps.filter((e) => isActive(e.status)).length;
  return {
    ok: true,
    counts: {
      enabledAd: adUsers.length,
      activeBamboo,
      active: activeCount,
      offboardingDebt: offboardingDebt.length,
      noBambooMatch: noBambooMatch.length,
      missingAccount: missingAccount.length,
    },
    offboardingDebt: offboardingDebt.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    noBambooMatch: noBambooMatch.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    missingAccount: missingAccount.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
  };
}
