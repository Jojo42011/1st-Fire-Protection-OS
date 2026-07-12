import { Router } from 'express';
import { resetDb } from '../db/reset';
import { integrationConnected } from '../config/integrations';

const router = Router();

/**
 * Reset the demo database — wipe all data and re-seed the sample dataset.
 *
 * Guard rails, because this is destructive:
 *  - Requires an explicit `{ "confirm": "reset" }` body so it can't fire by accident.
 *  - Refuses if ServiceTrade (the real system of record for invoices/jobs) is
 *    connected — that's the signal this instance may hold real data, not demo data.
 *    Set ALLOW_DEMO_RESET=1 to override intentionally.
 */
router.post('/api/admin/reset-demo', (req, res) => {
  if (req.body?.confirm !== 'reset') {
    return res.status(400).json({
      ok: false,
      error: 'confirmation required',
      hint: 'POST { "confirm": "reset" } to wipe and re-seed the demo database.',
    });
  }

  const override = process.env.ALLOW_DEMO_RESET === '1';
  if (integrationConnected('servicetrade') && !override) {
    return res.status(409).json({
      ok: false,
      error: 'refusing to reset: ServiceTrade is connected (this may be live data)',
      hint: 'Set ALLOW_DEMO_RESET=1 to override.',
    });
  }

  const result = resetDb();
  console.log(`[admin] demo DB reset — ${result.cleared} rows cleared, re-seeded.`);
  return res.json({ ok: true, ...result });
});

export default router;
