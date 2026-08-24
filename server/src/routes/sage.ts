import { Router } from 'express';
import { intacctConfigured, getIntacctMode, testConnection, listSageUsers } from '../services/sageIntacct';
import { sageUserReclaim } from '../services/sageReclaim';
import { seatAnalysis, setSeatOverride } from '../services/sageSeats';

/**
 * Sage Intacct read-only endpoints (scaffold). Live once a developer-license sender ID and a
 * web-services user are set via the INTACCT_* env vars. Everything here is read-only and keyless-safe.
 */
const router = Router();

/** Connection status the UI can show without making a live call. */
router.get('/api/sage/status', (_req, res) => {
  res.json({ ok: true, configured: intacctConfigured(), mode: getIntacctMode() });
});

/** Live connection test (opens a session; never writes). */
router.get('/api/sage/test', async (_req, res) => {
  const out = await testConnection();
  res.status(out.ok ? 200 : 400).json({ ok: out.ok, detail: out.detail });
});

/** The Sage user list, for the license-reclaim view. */
router.get('/api/sage/users', async (_req, res) => {
  const out = await listSageUsers();
  res.status(out.ok ? 200 : 400).json(out);
});

/** Sage users matched to BambooHR: flags terminated seats and users with no employee record. */
router.get('/api/sage/reclaim', async (_req, res) => {
  const out = await sageUserReclaim();
  res.status(out.ok ? 200 : 400).json(out);
});

/** Viewer-vs-doer seat classification + reclaimable-seat savings. */
router.get('/api/sage/seats', async (_req, res) => {
  const out = await seatAnalysis();
  res.status(out.ok ? 200 : 400).json(out);
});

/** Override one user's classification (viewer | doer | keep), or null to clear it. */
router.put('/api/sage/seats/override', (req, res) => {
  const b = req.body || {};
  const verdict = b.verdict === null ? null : String(b.verdict || '');
  if (verdict !== null && !['viewer', 'doer', 'keep'].includes(verdict)) return res.status(400).json({ ok: false, error: 'verdict must be viewer, doer, keep, or null' });
  res.json({ ok: true, overrides: setSeatOverride(String(b.loginId || ''), verdict as any) });
});

export default router;
