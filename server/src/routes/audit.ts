import { Router } from 'express';
import { getDb } from '../db/index';
import { auditState, capture, generateBrief, approveGap } from '../services/auditAgent';
import { calibration, resolvePrediction, PredStatus } from '../services/calibration';

const router = Router();

/** Full audit state — the map the canvas renders. */
router.get('/api/audit', (_req, res) => {
  res.json(auditState());
});

/** THE HERO: log one observation from the room → the operator brain analyzes + persists. */
router.post('/api/audit/capture', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });
  const location = req.body?.location ? String(req.body.location) : undefined;
  const department = req.body?.department ? String(req.body.department) : undefined;
  const questionId = req.body?.questionId ? Number(req.body.questionId) : undefined;
  try {
    const analysis = await capture(text, location, department, questionId);
    res.json({ ok: true, analysis, state: auditState() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/** Manual quick-adds while facilitating (system / person / workflow). In-house, reversible. */
router.post('/api/audit/entity', (req, res) => {
  const db = getDb();
  const kind = String(req.body?.kind || '');
  const b = req.body || {};
  try {
    if (kind === 'system') {
      db.prepare(`INSERT INTO audit_systems (name, category, truth_for, gaps, pillar_key) VALUES (?,?,?,?,?)`)
        .run(String(b.name), b.category || null, b.truth_for || null, b.gaps || null, b.pillar || null);
    } else if (kind === 'person') {
      db.prepare(`INSERT INTO audit_people (name, role, location, carries, risk, pillar_key) VALUES (?,?,?,?,?,?)`)
        .run(String(b.name), b.role || null, b.location || null, b.carries || null, b.risk || 'medium', b.pillar || null);
    } else if (kind === 'workflow') {
      db.prepare(`INSERT INTO audit_workflows (name, trigger_desc, stalls, pillar_key) VALUES (?,?,?,?)`)
        .run(String(b.name), b.trigger || null, b.stalls || null, b.pillar || null);
    } else {
      return res.status(400).json({ ok: false, error: 'kind must be system|person|workflow' });
    }
    res.json({ ok: true, state: auditState() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/** Dismiss / reopen a finding (reversible). */
router.post('/api/audit/findings/:id/status', (req, res) => {
  const status = String(req.body?.status || 'open');
  if (!['open', 'dismissed', 'building'].includes(status))
    return res.status(400).json({ ok: false, error: 'bad status' });
  getDb().prepare(`UPDATE audit_findings SET status = ? WHERE id = ?`).run(status, Number(req.params.id));
  res.json({ ok: true });
});

/** Approve a proposed build — the human gate that moves a gap into the build queue. */
router.post('/api/audit/findings/:id/approve', (req, res) => {
  try {
    approveGap(Number(req.params.id));
    res.json({ ok: true, state: auditState() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/** Mark a location mapped/unmapped while walking the sites. */
router.post('/api/audit/locations/:id/mapped', (req, res) => {
  const mapped = req.body?.mapped ? 1 : 0;
  getDb().prepare(`UPDATE audit_locations SET mapped = ? WHERE id = ?`).run(mapped, Number(req.params.id));
  res.json({ ok: true });
});

/** How well it knows: the calibration ledger (reliability curve, Brier, discount, log). */
router.get('/api/audit/calibration', (_req, res) => {
  res.json({ ok: true, calibration: calibration() });
});

/** Resolve an open prediction: the human gate that closes a call with a real outcome. */
router.post('/api/audit/predictions/:id/resolve', (req, res) => {
  const status = String(req.body?.status || '') as PredStatus;
  const actual = req.body?.actual_outcome ? String(req.body.actual_outcome) : undefined;
  const resolvedBy = req.body?.resolved_by ? String(req.body.resolved_by) : 'Devon';
  const at = new Date().toISOString();
  const r = resolvePrediction(Number(req.params.id), status, actual, resolvedBy, at);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  res.json({ ok: true, state: auditState() });
});

/** The deliverable: executive brief assembled live from the audit data. */
router.post('/api/audit/brief', async (_req, res) => {
  try {
    const brief = await generateBrief();
    res.json({ ok: true, ...brief });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
