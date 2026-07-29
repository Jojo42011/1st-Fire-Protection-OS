import { getDb } from '../db/index';
import { TRADE_CONFIG } from '../config/tradeConfig';
import { createApproval } from '../routes/approvals';
import { COMPANY } from '../config/constants';

/**
 * The Service-Plan Manager. Pure date math finds visits due and renewals due; drafting a
 * renewal (or a rate change) and proposing a plan are GATED. Renewals go out before an
 * agreement lapses — the recurring revenue you're entitled to and used to forget to bill.
 */

export interface Agreement {
  id: number;
  account_id: number | null;
  customer: string;
  plan_type: string;
  interval_days: number;
  price: number;
  status: string;
  started_at: string | null;
  next_service_at: string | null;
  renews_at: string | null;
}

const day = 86400000;
const daysUntil = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = new Date(iso.length <= 10 ? iso + 'T00:00:00Z' : iso).getTime();
  if (!isFinite(t)) return null;
  return Math.round((t - Date.now()) / day);
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00Z' : iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]}`; // day-first, e.g. "09 Aug"
};
const money = (n: number | null) => '$' + Number(n || 0).toLocaleString('en-US');

/** Agreements whose renewal falls inside the "soon" window. */
export function dueForRenewal(): Agreement[] {
  const db = getDb();
  const all = db.prepare(`SELECT * FROM service_agreements WHERE status != 'cancelled'`).all() as Agreement[];
  return all.filter((a) => {
    const d = daysUntil(a.renews_at);
    return d != null && d <= TRADE_CONFIG.plans.renewSoonDays;
  });
}

/** Agreements whose next scheduled visit is within the next two weeks. */
export function dueForVisit(): Agreement[] {
  const db = getDb();
  const all = db.prepare(`SELECT * FROM service_agreements WHERE status != 'cancelled'`).all() as Agreement[];
  return all.filter((a) => {
    const d = daysUntil(a.next_service_at);
    return d != null && d >= 0 && d <= 14;
  });
}

function renewalBody(a: Agreement): string {
  const first = a.customer.split(/\s|—/)[0];
  const sites = /(\d+)\s*sites?/i.exec(a.plan_type)?.[0] || 'the same buildings';
  return `Hi ${first} — your ${a.plan_type.split('·')[0].trim().toLowerCase()} agreement renews ${fmtDate(a.renews_at)}. Same ${sites}, same cadence, and we're holding your rate at ${money(a.price)}/yr. Say the word and I'll extend it another year; nothing changes on your end. — ${COMPANY.name}`;
}

/** Draft a renewal (GATED). raiseRate → a price change (quote_price, sensitive); otherwise a
 *  hold-the-rate renewal email (routine). */
export function draftRenewal(agreementId: number, raiseRate = false): { agreementId: number; kind: string; body: string } {
  const db = getDb();
  const a = db.prepare(`SELECT * FROM service_agreements WHERE id = ?`).get(agreementId) as Agreement | undefined;
  if (!a) throw new Error(`agreement ${agreementId} not found`);
  const body = renewalBody(a);
  if (raiseRate) {
    createApproval({
      agent_key: 'plans',
      kind: 'quote_price',
      risk: 'sensitive',
      title: `Rate change · ${a.customer}`,
      stake: `${money(Math.round(a.price * 1.06))}/yr`,
      body: `Propose renewing ${a.customer} at ${money(Math.round(a.price * 1.06))}/yr (was ${money(a.price)}/yr) — a 6% adjustment on the ${a.plan_type}.`,
      trail: 'New recurring price — needs your yes before it goes to the customer',
      subject_type: 'account',
      subject_id: a.account_id || agreementId,
    });
    return { agreementId, kind: 'quote_price', body };
  }
  createApproval({
    agent_key: 'plans',
    kind: 'send_email',
    risk: 'routine',
    title: `Renewal · ${a.customer}`,
    stake: `${money(a.price)}/yr`,
    body,
    trail: 'Goes to the agreement contact; holds the current rate',
    subject_type: 'account',
    subject_id: a.account_id || agreementId,
  });
  return { agreementId, kind: 'send_email', body };
}

// Finished one-time jobs that could become recurring agreements (curated shell fixtures).
export const PLAN_CANDIDATES = [
  { customer: 'Bulverde Self Storage', detail: '14 extinguishers serviced · would be $1,680/yr annual', annual: 1680, interval: 'annual' },
  { customer: 'Mi Tierra (Market Sq)', detail: 'Hood suppression re-cert · semi-annual fits code', annual: 2400, interval: 'semiannual' },
  { customer: 'Converse Fleet Services', detail: 'Recharges · quarterly route would suit the fleet', annual: 5200, interval: 'quarterly' },
];

/** Propose a recurring plan from a finished job (GATED — it's an offer to the customer). */
export function proposePlan(index: number): { customer: string } {
  const c = PLAN_CANDIDATES[index];
  if (!c) throw new Error(`candidate ${index} not found`);
  const first = c.customer.split(/\s|\(/)[0];
  createApproval({
    agent_key: 'plans',
    kind: 'send_email',
    risk: 'routine',
    title: `Propose a plan · ${c.customer}`,
    stake: `${money(c.annual)}/yr`,
    body: `Hi ${first} — the recent work is exactly what a service plan keeps ahead of. I'd set you up on a ${TRADE_CONFIG.plans.defaultIntervals[c.interval as 'annual' | 'semiannual' | 'quarterly']}-day cadence at ${money(c.annual)}/yr so it never lapses and you never get written up. Want me to put it in place? — ${COMPANY.name}`,
    trail: 'Offer to the customer; nothing recurring starts until they say yes',
    subject_type: 'account',
  });
  return { customer: c.customer };
}

export function getRecurringSummary() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM service_agreements WHERE status != 'cancelled' ORDER BY (renews_at IS NULL), renews_at ASC`).all() as Agreement[];
  const { renewSoonDays, renewUrgentDays } = TRADE_CONFIG.plans;

  // the soonest-lapsing agreement is the one with a renewal already drafted
  let soonestId = -1;
  let soonestDays = Infinity;
  for (const a of rows) {
    const d = daysUntil(a.renews_at);
    if (d != null && d >= 0 && d < soonestDays) {
      soonestDays = d;
      soonestId = a.id;
    }
  }

  const agreements = rows.map((a) => {
    const d = daysUntil(a.renews_at);
    const soon = d != null && d <= renewSoonDays;
    const urgent = d != null && d <= renewUrgentDays;
    const renewsText = soon ? `${fmtDate(a.renews_at)} · ${d}d` : fmtDate(a.renews_at);
    const isDrafted = a.id === soonestId && urgent;
    return {
      id: a.id,
      customer: a.customer,
      plan: a.plan_type,
      interval: `${a.interval_days}d`,
      price: money(a.price),
      next: fmtDate(a.next_service_at),
      renews: renewsText,
      renewPill: isDrafted ? 'money' : soon ? 'amber' : 'gray',
      cta: isDrafted ? 'Renewal drafted' : soon ? 'Draft renewal' : 'View',
      ctaDark: isDrafted,
    };
  });

  let activeRenewal = null;
  if (soonestId > 0) {
    const a = rows.find((x) => x.id === soonestId)!;
    const years = a.started_at ? new Date().getUTCFullYear() - Number(a.started_at.slice(0, 4)) : null;
    const sites = /(\d+)\s*sites?/i.exec(a.plan_type)?.[1];
    const metaBits = [`${money(a.price)}/yr`];
    if (sites) metaBits.push(`${sites} sites`);
    if (years) metaBits.push(`${years} years a customer`);
    activeRenewal = {
      agreementId: a.id,
      title: `Renewal · ${a.customer}`,
      meta: metaBits.join(' · '),
      lapsesIn: `lapses in ${soonestDays} days`,
      body: renewalBody(a),
    };
  }

  return {
    summary: { recurringRevenue: '$486,400', agreements: 118, lapsing: 9, dueVisit: 12 },
    agreements,
    activeRenewal,
    candidates: PLAN_CANDIDATES.map((c, i) => ({ index: i, customer: c.customer, detail: c.detail })),
    live: false,
  };
}
