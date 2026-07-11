import { Router } from 'express';
import { synthesize } from '../services/tts';

const router = Router();

/** TTS endpoint — returns mp3 or 204 when no key (client falls back to browser speech). */
router.post('/api/voice/tts', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const audio = await synthesize(text);
  if (!audio) return res.status(204).end();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.send(audio);
});

export default router;
