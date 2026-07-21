import { Router } from 'express';
import { listAgents, runAgent } from '../services/agentRuntime';

const router = Router();

/** The whole team: founding agents + every agent the harness has built. */
router.get('/api/roster', (_req, res) => {
  res.json({ agents: listAgents() });
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
