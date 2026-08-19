import { Router } from 'express';
import { operatingOffices } from '../os/office';
import { getDb } from '../db/index';

/**
 * The office roster that powers the global location switcher. Returns the audited set of true
 * operating offices (9), keyed by canonical office key so every scope-aware screen filters on the
 * same identity. Entity/support values (Management HQ, ASDS, OSC), the sister security company (VDS),
 * and demo/legacy metro labels are intentionally excluded from the operational selector.
 *
 * value = key (canonical) so the selection resolves cleanly through the OS scope layer.
 */
const router = Router();

router.get('/api/offices', (_req, res) => {
  // Active-employee headcount per canonical office key, straight from the roster (no estimate).
  const counts: Record<string, number> = {};
  try {
    const rows = getDb()
      .prepare(
        `SELECT os_office_key(office) AS k, COUNT(*) AS n
           FROM employees
          WHERE employment_status IN ('active','onboarding')
          GROUP BY k`
      )
      .all() as { k: string; n: number }[];
    for (const r of rows) if (r.k) counts[r.k] = r.n;
  } catch { /* roster table absent in some environments — omit headcounts */ }

  const offices = operatingOffices()
    .map((o) => ({ value: o.key, key: o.key, label: o.label, headcount: counts[o.key] ?? null }))
    .sort((a, b) => a.label.localeCompare(b.label));
  res.json({ offices });
});

export default router;
