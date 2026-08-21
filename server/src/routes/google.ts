/**
 * Google Business Profile connection: the owner signs in once (delegated OAuth), we keep a refresh
 * token, and from then on we can pull reviews and post replies. Keyless-safe: with no OAuth client
 * configured every route reports "not configured" instead of failing.
 *
 * Reply policy is fixed in the service: auto-reply + publish 4-5 star reviews; hold 3-and-under as a
 * draft for a human to approve on the Reviews screen.
 */
import { Router } from 'express';
import crypto from 'crypto';
import {
  connectionInfo,
  googleConfigured,
  authUrl,
  exchangeCode,
  disconnect,
  syncReviews,
} from '../services/googleBusiness';

const router = Router();

/** The redirect URI Google sends the code back to. Must be registered on the OAuth client, so an
 *  explicit GOOGLE_REDIRECT_URI wins; otherwise we derive it from the request. */
function redirectUri(req: any): string {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  return `${req.protocol}://${req.get('host')}/api/google/callback`;
}

/* ---- signed, short-lived CSRF state (same shape as the People OIDC flow) ---- */
const STATE_TTL = 10 * 60 * 1000;
function stateSecret(): string {
  return crypto.createHash('sha256').update('fpos-google|' + (process.env.PEOPLE_SESSION_SECRET || process.env.APP_PASSWORD || 'dev-secret')).digest('hex');
}
function signState(by: string): string {
  const body = Buffer.from(JSON.stringify({ by, exp: Date.now() + STATE_TTL })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
}
function readState(state: string | undefined): { by: string } | null {
  if (!state) return null;
  const dot = state.indexOf('.');
  if (dot < 0) return null;
  const body = state.slice(0, dot), sig = state.slice(dot + 1);
  const expect = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  try {
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof d.exp !== 'number' || d.exp < Date.now()) return null;
    return { by: d.by || 'operator' };
  } catch { return null; }
}

const actor = (req: any): string => (req.user?.email as string) || 'operator';

/** Connection status for the Integrations + Reviews screens. */
router.get('/api/google/status', (_req, res) => {
  res.json({ ok: true, ...connectionInfo() });
});

/** Start the consent flow: redirect the owner to Google. */
router.get('/api/google/auth', (req, res) => {
  if (!googleConfigured()) return res.status(503).json({ ok: false, error: 'Google is not configured yet (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' });
  res.redirect(authUrl(redirectUri(req), signState(actor(req))));
});

/** Google redirects back here with the code; exchange it and store the refresh token. */
router.get('/api/google/callback', async (req, res) => {
  const st = readState(String(req.query.state || ''));
  const code = String(req.query.code || '');
  if (req.query.error) { res.status(400).send('Google sign-in was cancelled or denied: ' + String(req.query.error)); return; }
  if (!code || !st) { res.status(400).send('Invalid Google sign-in state. Please try connecting again.'); return; }
  const out = await exchangeCode(code, redirectUri(req), st.by);
  if (!out.ok) { res.status(400).send('Could not connect Google: ' + (out.error || 'unknown error')); return; }
  res.redirect('/?tab=reviews-hub&google=connected');
});

/** Disconnect: forget the refresh token (reviews stay, no more sync/reply). */
router.post('/api/google/disconnect', (_req, res) => {
  disconnect();
  res.json({ ok: true });
});

/** Pull reviews now: auto-reply + publish positives, hold the rest as drafts. */
router.post('/api/google/sync', async (_req, res) => {
  const out = await syncReviews();
  res.status(out.ok ? 200 : 400).json(out);
});

export default router;
