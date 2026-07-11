import { Router } from 'express';
import { runTurn, streamTurn } from '../brain/agentLoop';

const router = Router();

/** Non-streaming chat. */
router.post('/api/brain/chat', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  const home = req.body?.home !== false;
  if (!text) return res.status(400).json({ error: 'text required' });
  const turn = await runTurn(text, home);
  res.json(turn);
});

/** SSE streaming chat (used by the receptionist home page). */
router.get('/api/brain/stream', async (req, res) => {
  const text = String(req.query.text || '').trim();
  const home = req.query.home !== 'false';
  if (!text) return res.status(400).json({ error: 'text required' });
  await streamTurn(text, res, home);
});

export default router;
