import { Router } from 'express';
import { requireOs } from '../os/authz';
import { P, REGISTRY } from '../os/policy';
import { readinessReport } from '../services/readiness';
import { listAudit } from '../os/audit';

/**
 * Production readiness API (admin-only). Returns a safe, non-secret posture snapshot plus the
 * authorization policy coverage map and a recent slice of the immutable OS audit trail. No secret
 * values, token digests, PII, raw webhooks, or database paths are ever returned.
 */
const router = Router();

router.get('/api/readiness', requireOs(P.readiness), (_req, res) => {
  res.json({ ok: true, readiness: readinessReport(), policy: REGISTRY });
});

router.get('/api/readiness/audit', requireOs(P.readiness), (req, res) => {
  const action = String(req.query.action || '') || undefined;
  res.json({ ok: true, entries: listAudit({ action, limit: 200 }) });
});

export default router;
