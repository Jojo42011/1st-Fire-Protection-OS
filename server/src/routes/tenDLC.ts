import { Router } from 'express';
import { tenDlcRegistration } from '../config/tenDLC';

const router = Router();

/**
 * A2P 10DLC registration packet for Twilio — Brand + Campaign fields, pre-filled
 * from the founder layer. `missing` lists any operator-only fields (EIN, contact)
 * still blank so the UI can flag them. Read-only; submitting to TCR is a gated,
 * human-approved step.
 */
router.get('/api/10dlc', (_req, res) => {
  res.json(tenDlcRegistration());
});

export default router;
