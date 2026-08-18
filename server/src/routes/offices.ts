import { Router } from 'express';
import { getDb } from '../db/index';
import { canonicalOffice, officeLabel, isNonOffice } from '../os/office';

/**
 * The office roster that powers the global location switcher. Data-driven from the mirror
 * (self-maintaining as offices appear), with the sister security company filtered out.
 * value = the full office string rows are tagged with (kept for backward-compatible screen filters);
 * key   = the canonical office key (the security identity used by the OS scope layer);
 * label = the friendly display name.
 */
const router = Router();

router.get('/api/offices', (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT o FROM (
         SELECT office AS o FROM sched_appointments WHERE office IS NOT NULL AND office != ''
         UNION SELECT office_name AS o FROM crm_jobs WHERE office_name IS NOT NULL AND office_name != ''
         UNION SELECT office AS o FROM quotes WHERE source='servicetrade' AND office IS NOT NULL AND office != ''
       ) ORDER BY o`
    )
    .all() as { o: string }[];
  const offices = rows
    .filter((r) => !isNonOffice(r.o)) // the sister security company is not a fire office
    .map((r) => ({ value: r.o, key: canonicalOffice(r.o), label: officeLabel(canonicalOffice(r.o)) || r.o }))
    .filter((o) => o.key)
    .sort((a, b) => a.label.localeCompare(b.label));
  res.json({ offices });
});

export default router;
