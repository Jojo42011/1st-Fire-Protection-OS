import { Router } from 'express';
import { runOperatorTurn, streamOperatorTurn, liveSnapshot } from '../services/operatorTwin';
import { activeProvider } from '../config/models';

const router = Router();

/** The twin's status + the snapshot the chat greets with. */
router.get('/api/operator', (_req, res) => {
  res.json({ brain: activeProvider() !== 'none', snapshot: liveSnapshot().lines });
});

/** Non-streaming chat (Jarvis mode uses this). */
router.post('/api/operator/chat', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  res.json(await runOperatorTurn(text));
});

/** SSE streaming chat (the chat surface). */
router.get('/api/operator/stream', async (req, res) => {
  const text = String(req.query.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  await streamOperatorTurn(text, res);
});

export default router;
