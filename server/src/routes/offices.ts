import { Router } from 'express';
import { operatingOffices } from '../os/office';

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
  const offices = operatingOffices()
    .map((o) => ({ value: o.key, key: o.key, label: o.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  res.json({ offices });
});

export default router;
