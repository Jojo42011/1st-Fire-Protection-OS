import { Router } from 'express';
import { getDb } from '../db/index';

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

export default router;
