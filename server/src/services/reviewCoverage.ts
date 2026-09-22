import { getDb } from '../db/index';
import { SWEEP_MAX_AGE_DAYS } from './reviewRequests';

/**
 * Review-request coverage: for every completed ServiceTrade job in the mirror, did it get a request,
 * and if not, why. Also sizes the text-message pool (who has a phone) and one-time customers, the
 * audience for a reactivation campaign.
 */

export type CoverageReason =
  | 'sent' | 'queued' | 'repeat_customer' | 'no_email_has_phone' | 'no_contact'
  | 'office_off' | 'too_old' | 'waiting';

export const REASON_LABEL: Record<CoverageReason, string> = {
  sent: 'Request sent',
  queued: 'Queued to send',
  repeat_customer: 'Skipped: same email asked in the last 90 days',
  no_email_has_phone: 'No email, has a phone (text-only)',
  no_contact: 'No email or phone on the job',
  office_off: 'Office not mapped or paused',
  too_old: `Completed more than ${SWEEP_MAX_AGE_DAYS} days ago`,
  waiting: 'Eligible, goes out on the next sweep',
};

export interface CoverageJob {
  id: number; number: string | null; completed_at: string | null; office_name: string | null;
  customer: string | null; customer_key: string; contact_name: string | null; contact_email: string | null;
  contact_phone: string | null; contact_mobile: string | null; reason: CoverageReason;
  sent_at: string | null; clicked_at: string | null;
}

const digits = (s: string | null) => {
  const d = String(s || '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '1' ? d.slice(1) : d.length === 10 ? d : '';
};

/** Every completed ServiceTrade job with its request status and reason. */
export function coverageJobs(now = new Date()): CoverageJob[] {
  const cutoff = new Date(now.getTime() - SWEEP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT j.id, j.number, j.completed_at, j.office_name, a.name AS customer,
              COALESCE(CAST(j.account_id AS TEXT), 'email:' || j.contact_email, 'job:' || j.id) AS customer_key,
              j.contact_name, j.contact_email, j.contact_phone, j.contact_mobile,
              COALESCE(j.review_requested, 0) AS asked,
              t.review_url AS target_url, COALESCE(t.active, 0) AS target_active,
              rr.best, rr.sent_at, rr.clicked_at
         FROM crm_jobs j
         LEFT JOIN accounts a ON a.id = j.account_id
         LEFT JOIN review_targets t ON t.office_id = j.office_id
         LEFT JOIN (
           SELECT job_id,
                  MAX(CASE WHEN status = 'sent' THEN 2 WHEN status IN ('held','approved') THEN 1 ELSE 0 END) AS best,
                  MAX(sent_at) AS sent_at, MAX(clicked_at) AS clicked_at
             FROM review_requests WHERE source = 'servicetrade' AND job_id IS NOT NULL GROUP BY job_id
         ) rr ON rr.job_id = j.id
        WHERE j.source = 'servicetrade' AND lower(j.status) LIKE '%complete%'
        ORDER BY j.completed_at DESC`
    )
    .all() as any[];
  return rows.map((r) => {
    let reason: CoverageReason;
    if (r.best === 2) reason = 'sent';
    else if (r.best === 1) reason = 'queued';
    else if (r.asked) reason = 'repeat_customer';
    else if (!r.contact_email) reason = digits(r.contact_phone) ? 'no_email_has_phone' : 'no_contact';
    else if (!r.target_url || !r.target_active) reason = 'office_off';
    else if (!r.completed_at || r.completed_at < cutoff) reason = 'too_old';
    else reason = 'waiting';
    return {
      id: r.id, number: r.number, completed_at: r.completed_at, office_name: r.office_name, customer: r.customer,
      customer_key: r.customer_key, contact_name: r.contact_name, contact_email: r.contact_email,
      contact_phone: r.contact_phone, contact_mobile: r.contact_mobile, reason,
      sent_at: r.best === 2 ? r.sent_at : null, clicked_at: r.clicked_at,
    };
  });
}

export function coverageReport(now = new Date()) {
  const jobs = coverageJobs(now);
  const byReason = Object.fromEntries(Object.keys(REASON_LABEL).map((k) => [k, 0])) as Record<CoverageReason, number>;
  const offices = new Map<string, { office_name: string; completed: number; sent: number; notSent: number; textOnly: number; withPhone: number }>();
  const phones = new Set<string>(), mobiles = new Set<string>(), textOnlyPhones = new Set<string>();
  let jobsWithPhone = 0, jobsWithMobile = 0;
  let first: string | null = null, last: string | null = null;

  for (const j of jobs) {
    byReason[j.reason]++;
    const ph = digits(j.contact_phone), mob = digits(j.contact_mobile);
    if (ph) { jobsWithPhone++; phones.add(ph); }
    if (mob) { jobsWithMobile++; mobiles.add(mob); }
    if (ph && !j.contact_email) textOnlyPhones.add(ph);
    if (j.completed_at) { if (!first || j.completed_at < first) first = j.completed_at; if (!last || j.completed_at > last) last = j.completed_at; }
    const k = j.office_name || 'Unassigned';
    const o = offices.get(k) || { office_name: k, completed: 0, sent: 0, notSent: 0, textOnly: 0, withPhone: 0 };
    o.completed++;
    if (j.reason === 'sent') o.sent++; else o.notSent++;
    if (j.reason === 'no_email_has_phone') o.textOnly++;
    if (ph) o.withPhone++;
    offices.set(k, o);
  }

  // One-time customers: exactly one completed job in the history we hold.
  const byCustomer = new Map<string, CoverageJob[]>();
  for (const j of jobs) {
    const list = byCustomer.get(j.customer_key) || [];
    list.push(j);
    byCustomer.set(j.customer_key, list);
  }
  const day = 24 * 60 * 60 * 1000;
  const oneOff = { customers: 0, neverAsked: 0, withEmail: 0, phoneOnly: 0, annualDue: 0 };
  for (const list of byCustomer.values()) {
    if (list.length !== 1) continue;
    const j = list[0];
    oneOff.customers++;
    if (j.reason !== 'sent' && j.reason !== 'queued') oneOff.neverAsked++;
    if (j.contact_email) oneOff.withEmail++;
    else if (digits(j.contact_phone)) oneOff.phoneOnly++;
    const age = j.completed_at ? (now.getTime() - Date.parse(j.completed_at)) / day : 0;
    if (age >= 300 && age <= 450) oneOff.annualDue++; // 10 to 15 months: the next annual inspection is due
  }

  return {
    ok: true as const,
    history: { first, last, days: first ? Math.round((now.getTime() - Date.parse(first)) / day) : 0 },
    completed: jobs.length,
    customers: byCustomer.size,
    byReason,
    reasonLabels: REASON_LABEL,
    phones: {
      jobsWithPhone, jobsWithMobile,
      uniqueNumbers: phones.size, uniqueMobiles: mobiles.size, textOnlyNumbers: textOnlyPhones.size,
    },
    oneOff,
    offices: Array.from(offices.values()).sort((a, b) => b.completed - a.completed),
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // keep spreadsheet apps from running cell formulas
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The same per-job status as a CSV, for a spreadsheet or a campaign list. */
export function coverageCsv(now = new Date()): string {
  const jobs = coverageJobs(now);
  const count = new Map<string, number>();
  for (const j of jobs) count.set(j.customer_key, (count.get(j.customer_key) || 0) + 1);
  const head = ['job_number', 'completed', 'office', 'customer', 'contact', 'email', 'phone', 'mobile', 'jobs_for_customer', 'status', 'sent_at', 'clicked_at'];
  const lines = [head.join(',')];
  for (const j of jobs) {
    lines.push([
      j.number, (j.completed_at || '').slice(0, 10), j.office_name, j.customer, j.contact_name, j.contact_email,
      j.contact_phone, j.contact_mobile, count.get(j.customer_key) || 1, REASON_LABEL[j.reason],
      (j.sent_at || '').slice(0, 10), (j.clicked_at || '').slice(0, 10),
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
