import { Router } from 'express';
import { currentContext } from '../os/scope';
import { listWork, workSummary } from '../os/work';

/**
 * Unified Work API. Aggregates People tasks + exception remediation into one normalized, office-scoped
 * task list for Work > My Tasks. Read-only aggregation; the actual "complete"/"resolve" actions go to
 * the domain endpoints (/api/people/tasks/:id/complete, /api/exceptions/:id/status) so their own
 * authorization and side effects stay intact.
 */
const router = Router();

router.get('/api/work/tasks', (req, res) => {
  const ctx = currentContext(req);
  const tasks = listWork(ctx, {
    mine: req.query.mine === '1',
    team: req.query.team as string,
    group: req.query.group as string,
  });
  res.json({ ok: true, tasks });
});

router.get('/api/work/summary', (req, res) => {
  const ctx = currentContext(req);
  res.json({ ok: true, summary: workSummary(ctx, { mine: req.query.mine === '1', team: req.query.team as string }) });
});

export default router;
