import { Router } from 'express';
import { activeProvider, embeddingsEnabled } from '../config/models';
import { telephonyEnabled, ttsEnabled } from '../config/voice';

const router = Router();

router.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: '1st-fp-os',
    time: new Date().toISOString(),
    brain: activeProvider(),
    embeddings: embeddingsEnabled(),
    tts: ttsEnabled(),
    telephony: telephonyEnabled(),
  });
});

export default router;
