import { Router } from 'express';
import { listAgents, runAgent } from '../services/agentRuntime';
import { getDb } from '../db/index';

const router = Router();

const ST_OPEN = "('draft','submitted','pending','reviewed','contingent')";
const fmtMoney = (dollars: number): string =>
  dollars >= 1e6 ? '$' + (dollars / 1e6).toFixed(1) + 'M' : dollars >= 1e3 ? '$' + Math.round(dollars / 1e3) + 'k' : '$' + Math.round(dollars);

/**
 * Headline stat per founding agent. Real where a ServiceTrade source exists (Closer off open
 * quotes, Dispatcher off scheduled jobs); the rest fall back to the client's shell figures.
 */
function agentStats(): Record<string, [string, string]> {
  const db = getDb();
  const num = (sql: string) => { try { return (db.prepare(sql).get() as { v: number }).v || 0; } catch { return 0; } };
  const out: Record<string, [string, string]> = {};

  const openCents = num(`SELECT COALESCE(SUM(amount_cents),0) AS v FROM quotes WHERE source='servicetrade' AND lower(stage) IN ${ST_OPEN}`);
  if (openCents > 0) out.closer = [fmtMoney(openCents / 100), 'in play'];

  const jobs = num(`SELECT COUNT(*) AS v FROM crm_jobs WHERE source='servicetrade'`);
  if (jobs > 0) out.dispatch = [jobs.toLocaleString('en-US'), 'jobs scheduled'];

  return out;
}

/** The whole team: founding agents + every agent the harness has built. */
router.get('/api/roster', (_req, res) => {
  res.json({ agents: listAgents(), stats: agentStats() });
});

/** Talk to any agent on the roster - the generic runtime runs its persona + shared brain. */
router.post('/api/roster/:key/chat', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });
  try {
    const r = await runAgent(req.params.key, text);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
