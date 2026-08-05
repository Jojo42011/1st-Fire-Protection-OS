import { Router } from 'express';
import { getScheduleSummary, approveSlot, proposeSchedule, draftReminder, backfill } from '../services/dispatchAgent';
import { syncSchedule } from '../services/scheduleSync';

/**
 * The Dispatcher (Phase 5). GET serves the crew-week grid, the active proposal, the waitlist
 * and the no-show panel. Approving a slot, proposing a waitlisted job, drafting a reminder and
 * backfilling a cancellation are all gated. live:false.
 */
const router = Router();

router.get('/api/schedule', (req, res) => {
  res.json(getScheduleSummary(String(req.query.office || '')));
});

// Pull scheduled appointments + assigned techs from ServiceTrade into the mirror (read-only).
router.post('/api/schedule/sync', async (_req, res) => {
  try {
    const r = await syncSchedule();
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.post('/api/schedule/:id/approve', (req, res) => {
  try {
    const r = approveSlot(Number(req.params.id));
    res.json({ ok: true, ...r, live: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.post('/api/schedule/propose', (req, res) => {
  try {
    const r = proposeSchedule(Number(req.body?.wait_id ?? req.body?.waitId ?? 0));
    res.json({ ok: true, ...r, live: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.post('/api/schedule/:id/reminder', (req, res) => {
  try {
    const r = draftReminder(Number(req.params.id));
    res.json({ ok: true, ...r, live: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.post('/api/schedule/backfill', (_req, res) => {
  try {
    const r = backfill();
    res.json({ ok: true, ...r, live: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
