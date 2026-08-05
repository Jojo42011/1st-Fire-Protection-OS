import { Router } from 'express';
import { getDb } from '../db/index';
import { stGet, stConfigured } from '../services/servicetrade';

/**
 * Read-only sizing for the FIREPROSHIELD recurring-maintenance program. Segments the real
 * ServiceTrade account book into the four SHIELD membership tiers using property-type inference
 * (from the account name) plus multi-site and account-value signals, and returns the addressable
 * base per tier. No writes; pure analytics over the mirror. Same spirit as the Teams PSTN endpoint.
 *
 * Tier proxies (heuristic, meant to be refined by sales knowledge of the accounts):
 *   Premier (Industrial Plants)   <- industrial property type
 *   Plus    (Property Managers)   <- multi-site accounts (3+ sites)
 *   Core    (Small Businesses)    <- single/low-site commercial with activity
 *   Basic   (Owners / End Users)  <- single-site, minimal activity
 */
const router = Router();

type Tier = 'Premier' | 'Plus' | 'Core' | 'Basic';

function inferType(name: string): string {
  const t = (name || '').toLowerCase();
  if (/manufactur|warehouse|distribution|logistics|\bplant\b|industrial|data center|refinery|steel|chemical|plastics|fabricat|foundry|mill\b|processing/.test(t)) return 'industrial';
  if (/\bisd\b|school|independent school|university|college|academy|\bcisd\b/.test(t)) return 'education';
  if (/hospital|medical|clinic|health|surgery|dental|nursing|\bcare\b|pharmacy/.test(t)) return 'healthcare';
  if (/hotel|\binn\b|suites|resort|restaurant|grill|cafe|kitchen|hospitality|marriott|hilton|hampton|taqueria|bbq|brewing|bar &/.test(t)) return 'hospitality';
  if (/apartment|multifamily|residence|villas|lofts|housing|senior living|townhome|\bflats\b/.test(t)) return 'multifamily';
  if (/storage/.test(t)) return 'storage';
  if (/city of|county|municipal|police|sheriff|\bgov\b|courthouse|\bfire department\b/.test(t)) return 'government';
  if (/church|ministry|baptist|catholic|worship|chapel|parish/.test(t)) return 'religious';
  if (/retail|store|shop|\bmall\b|plaza|market|grocery|dollar|\bh-?e-?b\b|walmart|outlet/.test(t)) return 'retail';
  return 'commercial';
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

router.get('/api/proposal/tier-sizing', (_req, res) => {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT a.id, a.name, a.lifetime_cents AS lc, a.balance_cents AS bc, a.contract_type AS ct,
                (SELECT COUNT(*) FROM sites s WHERE s.account_id = a.id) AS sites
         FROM accounts a WHERE a.source = 'servicetrade'`
      )
      .all() as { id: number; name: string; lc: number; bc: number; ct: string | null; sites: number }[];

    const total = rows.length;
    const lifetimes = rows.map((r) => r.lc || 0).sort((a, b) => a - b);
    const valueTop = pct(lifetimes, 90); // top-decile lifetime value -> "large account"
    const activeThreshold = 50000; // $500 lifetime, a proxy for "a real, active account" (cents)

    const typeCount: Record<string, number> = {};
    const tiers: Record<Tier, { count: number; lifetime_cents: number; sites: number; withBalance: number }> = {
      Premier: { count: 0, lifetime_cents: 0, sites: 0, withBalance: 0 },
      Plus: { count: 0, lifetime_cents: 0, sites: 0, withBalance: 0 },
      Core: { count: 0, lifetime_cents: 0, sites: 0, withBalance: 0 },
      Basic: { count: 0, lifetime_cents: 0, sites: 0, withBalance: 0 },
    };

    let multiSite = 0, singleSite = 0, zeroSite = 0, totalSites = 0, totalLifetime = 0;

    for (const r of rows) {
      const type = inferType(r.name);
      typeCount[type] = (typeCount[type] || 0) + 1;
      const sites = r.sites || 0;
      totalSites += sites;
      totalLifetime += r.lc || 0;
      if (sites >= 3) multiSite++;
      else if (sites === 1 || sites === 2) singleSite++;
      else zeroSite++;

      // Tier waterfall (first match wins).
      let tier: Tier;
      if (sites >= 3) tier = 'Plus';                                  // property-manager profile
      else if (type === 'industrial') tier = 'Premier';              // industrial plant
      else if ((r.lc || 0) >= valueTop) tier = 'Premier';           // very large single account
      else if ((r.lc || 0) >= activeThreshold) tier = 'Core';       // active small business
      else tier = 'Basic';                                          // single-site / minimal activity

      tiers[tier].count++;
      tiers[tier].lifetime_cents += r.lc || 0;
      tiers[tier].sites += sites;
      if ((r.bc || 0) > 0) tiers[tier].withBalance++;
    }

    res.json({
      ok: true,
      generatedFrom: 'accounts where source=servicetrade',
      totals: {
        accounts: total,
        totalSites,
        multiSite3plus: multiSite,
        oneOrTwoSites: singleSite,
        zeroSites: zeroSite,
        totalLifetimeUsd: Math.round(totalLifetime / 100),
        medianLifetimeUsd: Math.round(pct(lifetimes, 50) / 100),
        p90LifetimeUsd: Math.round(valueTop / 100),
      },
      typeBreakdown: Object.fromEntries(Object.entries(typeCount).sort((a, b) => b[1] - a[1])),
      tiers: Object.fromEntries(
        (Object.keys(tiers) as Tier[]).map((k) => [
          k,
          {
            accounts: tiers[k].count,
            sites: tiers[k].sites,
            withOpenBalance: tiers[k].withBalance,
            lifetimeUsd: Math.round(tiers[k].lifetime_cents / 100),
            avgLifetimeUsd: tiers[k].count ? Math.round(tiers[k].lifetime_cents / tiers[k].count / 100) : 0,
          },
        ])
      ),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * Live deficiency pull from the ServiceTrade API (deficiencies are not in the local mirror).
 * Sizes the un-converted repair backlog: how many open deficiencies exist and the estimated
 * repair dollars sitting in them (proposedProceeds). This is the revenue the membership would
 * systematically convert. Read-only; pages through /deficiency and aggregates.
 */
router.get('/api/proposal/deficiencies', async (req, res) => {
  if (!stConfigured()) return res.status(400).json({ ok: false, error: 'ServiceTrade not connected' });
  try {
    const status = String(req.query.status || '').trim(); // optional passthrough once we know valid values
    const limit = 1000;
    let page = 1, totalPages = 1, guard = 0;
    const all: any[] = [];
    while (page <= totalPages && guard++ < 80) {
      const q = `/deficiency?limit=${limit}&page=${page}${status ? `&status=${encodeURIComponent(status)}` : ''}`;
      const r: any = await stGet(q);
      const d = r?.data || r;
      const arr = d?.deficiencies || d?.data || (Array.isArray(d) ? d : []);
      totalPages = Number(d?.totalPages || 1);
      for (const x of arr) all.push(x);
      page++;
      if (!arr.length) break;
    }

    const byStatus: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let proceedsSum = 0, proceedsN = 0;
    for (const x of all) {
      const st = String(x.status ?? x.serviceStatus ?? 'unknown');
      byStatus[st] = (byStatus[st] || 0) + 1;
      const sev = String(x.severity ?? 'unspecified');
      bySeverity[sev] = (bySeverity[sev] || 0) + 1;
      const pp = Number(x.proposedProceeds ?? x.proposed_proceeds ?? x.estimatedProceeds ?? 0);
      if (isFinite(pp) && pp > 0) { proceedsSum += pp; proceedsN++; }
    }

    res.json({
      ok: true,
      total: all.length,
      totalPages,
      byStatus: Object.fromEntries(Object.entries(byStatus).sort((a, b) => b[1] - a[1])),
      bySeverity: Object.fromEntries(Object.entries(bySeverity).sort((a, b) => b[1] - a[1])),
      proposedProceeds: { withValue: proceedsN, sumUsd: Math.round(proceedsSum), avgUsd: proceedsN ? Math.round(proceedsSum / proceedsN) : 0 },
      sampleKeys: all[0] ? Object.keys(all[0]) : [],
      sample: all[0] || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// temp: probe ServiceTrade for the real recurring-service source (contracts / job types / recurrence)
router.get('/api/proposal/plans-probe', async (_req, res) => {
  if (!stConfigured()) return res.status(400).json({ ok: false, error: 'ServiceTrade not connected' });
  const out: any = {};
  const tryGet = async (label: string, path: string) => {
    try {
      const r: any = await stGet(path);
      const d = r?.data || r;
      const key = Object.keys(d || {}).find((k) => Array.isArray((d as any)[k]));
      const arr = key ? (d as any)[key] : Array.isArray(d) ? d : [];
      out[label] = { ok: true, totalPages: d?.totalPages, count: arr.length, keys: arr[0] ? Object.keys(arr[0]) : Object.keys(d || {}), sample: arr[0] };
    } catch (e) { out[label] = { ok: false, error: (e as Error).message }; }
  };
  await tryGet('servicecontract', '/servicecontract?limit=2');
  await tryGet('recurringService', '/recurringservice?limit=2');
  // job types distribution over a page
  try {
    const r: any = await stGet('/job?limit=100');
    const d = r?.data || r;
    const jobs = d?.jobs || [];
    const byType: Record<string, number> = {};
    for (const j of jobs) byType[j.type || j.jobType || 'unknown'] = (byType[j.type || j.jobType || 'unknown'] || 0) + 1;
    out.jobTypes = byType;
  } catch (e) { out.jobTypes = { error: (e as Error).message }; }
  // sample a page and characterize recurring service requests
  try {
    const r: any = await stGet('/servicerequest?limit=100');
    const d = r?.data || r;
    const srs = d?.serviceRequest || d?.serviceRequests || [];
    const recurring = srs.filter((s: any) => s.serviceRecurrence);
    const withContract = srs.filter((s: any) => s.contract);
    out.srSummary = { inPage: srs.length, withRecurrence: recurring.length, withContract: withContract.length };
    out.recurringSample = recurring[0] ? {
      serviceLine: recurring[0].serviceLine,
      serviceRecurrence: recurring[0].serviceRecurrence,
      contract: recurring[0].contract,
      location: recurring[0].location?.name,
      status: recurring[0].status,
    } : null;
  } catch (e) { out.srSummary = { error: (e as Error).message }; }
  res.json(out);
});

export default router;
