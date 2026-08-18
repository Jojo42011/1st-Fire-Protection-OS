import { Router } from 'express';
import { currentContext } from '../os/scope';
import { detectExceptions, listExceptions, exceptionSummary, setExceptionStatus } from '../os/exceptions';

/**
 * Exceptions API (Phase 3) — the Work > Exceptions queue.
 *   GET  /api/exceptions            — scoped list (filters: status, category, owner, severity, office)
 *   GET  /api/exceptions/summary    — counts by owner/severity + total financial impact, in scope
 *   POST /api/exceptions/detect     — re-run detectors (idempotent)
 *   POST /api/exceptions/:id/status — resolve / dismiss / assign, scope-checked
 * Every read and write enforces the caller's office scope server-side.
 */
const router = Router();

router.get('/api/exceptions', (req, res) => {
  const ctx = currentContext(req);
  const rows = listExceptions(ctx, {
    status: (req.query.status as string) || 'open',
    category: req.query.category as string,
    owner: req.query.owner as string,
    severity: req.query.severity as string,
    office: req.query.office as string,
  });
  res.json({ ok: true, exceptions: rows });
});

router.get('/api/exceptions/summary', (req, res) => {
  res.json({ ok: true, summary: exceptionSummary(currentContext(req)) });
});

router.post('/api/exceptions/detect', (_req, res) => {
  try {
    const results = detectExceptions();
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.post('/api/exceptions/:id/status', (req, res) => {
  const ctx = currentContext(req);
  const out = setExceptionStatus(ctx, Number(req.params.id), String(req.body?.status || ''), req.body?.note);
  if (!out.ok) return res.status(out.error === 'office_forbidden' ? 403 : out.error === 'not_found' ? 404 : 400).json(out);
  res.json(out);
});

export default router;
