import { Router } from 'express';
import { getDb } from '../db/index';

/**
 * The office roster that powers the global location switcher. Data-driven from the schedule
 * mirror (self-maintaining as offices appear), with the sister security company filtered out.
 * value = the full ServiceTrade office name (what rows are tagged with); label = friendly short.
 */
const router = Router();

const shortLabel = (o: string): string => {
  const s = (o || '').replace(/^1st FP\s*/i, '').replace(/\s*LLC$/i, '').trim();
  return /^services$/i.test(s) ? 'San Antonio' : s || o;
};

router.get('/api/offices', (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT o FROM (
         SELECT office AS o FROM sched_appointments WHERE office IS NOT NULL AND office != ''
         UNION
         SELECT office AS o FROM quotes WHERE source='servicetrade' AND office IS NOT NULL AND office != ''
       ) ORDER BY o`
    )
    .all() as { o: string }[];
  const offices = rows
    .filter((r) => !/video digital|vds/i.test(r.o)) // the sister security company is not a fire office
    .map((r) => ({ value: r.o, label: shortLabel(r.o) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  res.json({ offices });
});

export default router;
