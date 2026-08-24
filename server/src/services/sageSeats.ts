import { getState, setState } from '../db/schema';
import { listSageUsers, intacctReadByQuery, SageUser } from './sageIntacct';
import { buildEmployeeIndex, matchAdToEmployee } from './adAudit';

/**
 * Sage Intacct viewer-vs-doer seat analysis.
 *
 * A "doer" enters transactions (AP/AR/GL/purchasing/admin) and needs a Sage seat. A "viewer" only
 * looks at data and could work out of the OS instead, freeing a Business seat ($2,750/yr). This
 * classifies each user from their assigned Sage roles, biased CONSERVATIVE: anything that looks like
 * entry or admin is a doer (keep the seat), so savings are never overstated. A People admin overrides
 * per person, and the reclaimable total updates. Read-only; keyless-safe (no-op until Sage connects).
 *
 * Runs the moment a developer-license sender ID + web-services user are set (the INTACCT_* env vars).
 */

const OVERRIDE_KEY = 'sage_seat_overrides'; // { loginId: 'viewer' | 'doer' | 'keep' }

// Effective annual price per seat by Sage user type (from the license workbook).
const SEAT_PRICE: Record<string, number> = {
  business: 2750,
  'construction manager': 378, // $1,890 / 5-pack
  employee: 148,               // $1,485 / 10-pack
};
function seatPrice(type: string | null): number {
  const t = (type || '').toLowerCase();
  for (const k of Object.keys(SEAT_PRICE)) if (t.includes(k.split(' ')[0])) return SEAT_PRICE[k];
  return 0;
}

// Role-name signals. Doer takes precedence: if any doer role is present, the user keeps their seat.
const DOER = /\b(all access|admin|ap|ar|gl|general ledger|purchas\w*|order entry|construction accountant|accountant|entr(y|ies)|create|invoice|bill|journal|cash|bank|payroll|po)\b/i;
const VIEWER = /\b(view[ -]?only|read[ -]?only|reporting|report|inquiry|viewer|dashboard)\b/i;

export type SeatVerdict = 'doer' | 'viewer' | 'review';
export interface SeatFinding {
  loginId: string | null;
  name: string | null;
  email: string | null;
  type: string | null;
  roles: string[];
  suggested: SeatVerdict;   // from the role heuristic
  override: SeatVerdict | 'keep' | null;
  effective: SeatVerdict | 'keep'; // override if set, else suggested
  homeStatus: string | null;       // matched employee's employment status
  seatPrice: number;
  reclaimable: number;             // dollars freed if this seat is dropped
}

function readOverrides(): Record<string, string> {
  const raw = getState(OVERRIDE_KEY);
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
export function setSeatOverride(loginId: string, verdict: 'viewer' | 'doer' | 'keep' | null): Record<string, string> {
  const m = readOverrides();
  if (!loginId) return m;
  if (verdict === null) delete m[loginId]; else m[loginId] = verdict;
  setState(OVERRIDE_KEY, JSON.stringify(m));
  return m;
}

/** Pull each user's Sage role names, keyed by login id. Tolerant of the USERROLE shape; empty on any
 *  failure so the classifier falls back to user type alone. */
async function rolesByUser(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const rows = await intacctReadByQuery('USERROLE', ['USERID', 'ROLENAME', 'ROLEID']);
    for (const r of rows) {
      const uid = (r.USERID || '').toLowerCase();
      const role = r.ROLENAME || r.ROLEID;
      if (!uid || !role) continue;
      if (!out.has(uid)) out.set(uid, []);
      out.get(uid)!.push(role);
    }
  } catch { /* leave empty; classify from type */ }
  return out;
}

function classify(roles: string[]): SeatVerdict {
  if (roles.some((r) => DOER.test(r))) return 'doer';
  if (roles.length && roles.every((r) => VIEWER.test(r))) return 'viewer';
  if (roles.some((r) => VIEWER.test(r))) return 'viewer';
  return 'review';
}

export async function seatAnalysis(): Promise<{
  ok: boolean; error?: string;
  findings: SeatFinding[];
  summary: { users: number; doers: number; viewers: number; review: number; reclaimableSeats: number; reclaimableAnnual: number };
}> {
  const res = await listSageUsers();
  if (!res.ok) return { ok: false, error: res.error, findings: [], summary: { users: 0, doers: 0, viewers: 0, review: 0, reclaimableSeats: 0, reclaimableAnnual: 0 } };

  const roles = await rolesByUser();
  const overrides = readOverrides();
  const idx = buildEmployeeIndex();

  const findings: SeatFinding[] = res.users.map((u: SageUser) => {
    const rs = (u.loginId ? roles.get(u.loginId.toLowerCase()) : undefined) || [];
    const suggested = classify(rs);
    const ov = (u.loginId && overrides[u.loginId]) as SeatFinding['override'] || null;
    const effective = (ov || suggested) as SeatFinding['effective'];
    const emp = matchAdToEmployee({ email: u.email, upn: u.email }, idx);
    const price = seatPrice(u.type);
    const terminated = emp && (emp.employment_status || '').toLowerCase() === 'terminated';
    // Reclaimable when the seat is a viewer (can move to OS) OR the person is terminated, and it's paid.
    const reclaimable = (effective === 'viewer' || terminated) ? price : 0;
    return {
      loginId: u.loginId, name: u.name, email: u.email, type: u.type, roles: rs,
      suggested, override: ov, effective, homeStatus: emp ? emp.employment_status : null,
      seatPrice: price, reclaimable,
    };
  });

  // Order: reclaimable first (biggest dollars), then review, then doers.
  const rank = (f: SeatFinding) => (f.reclaimable > 0 ? 0 : f.effective === 'review' ? 1 : 2);
  findings.sort((a, b) => rank(a) - rank(b) || b.seatPrice - a.seatPrice);

  const summary = {
    users: findings.length,
    doers: findings.filter((f) => f.effective === 'doer').length,
    viewers: findings.filter((f) => f.effective === 'viewer').length,
    review: findings.filter((f) => f.effective === 'review').length,
    reclaimableSeats: findings.filter((f) => f.reclaimable > 0).length,
    reclaimableAnnual: findings.reduce((s, f) => s + f.reclaimable, 0),
  };
  return { ok: true, findings, summary };
}
