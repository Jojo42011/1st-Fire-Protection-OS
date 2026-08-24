import { Router } from 'express';
import { intacctConfigured, getIntacctMode, testConnection, listSageUsers } from '../services/sageIntacct';
import { sageUserReclaim } from '../services/sageReclaim';

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

export default router;
