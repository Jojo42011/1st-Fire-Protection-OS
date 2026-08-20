/**
 * Public, tokenised intake routes. A hiring manager with no OS account opens /intake/:token, fills
 * the 5-step form, and submits. The token (single-use, 7-day expiry) is the only credential; the
 * auth gate allows these paths and the intake service enforces the token's validity on every call.
 */
import { Router } from 'express';
import path from 'path';
import { resolveToken, markOpened, submitIntake, boundHire } from '../services/intakeLinks';
import { operatingOffices } from '../os/office';
import { getDb } from '../db/index';
import { catalogByKind } from '../services/onboardingCatalog';
import { computerTierList, DOCK_PRICE } from '../services/onboardingAgent';

// The real offices, role templates, and the editable onboarding catalog, so the manager intake form
// offers the exact same operational options as the internal full form (not a hardcoded few).
function intakeOptions(): {
  offices: string[];
  positions: string[];
  catalog: { software: string[]; sharepoint: string[]; printers: string[]; computers: { key: string; label: string; spec: string; price: number }[]; dockPrice: number };
} {
  const offices = operatingOffices().map((o) => o.label);
  let positions: string[] = [];
  try {
    positions = (getDb().prepare(`SELECT name FROM job_positions WHERE active = 1 ORDER BY name`).all() as { name: string }[]).map((r) => r.name).filter(Boolean);
  } catch { positions = []; }
  const catalog = {
    software: catalogByKind('software').map((s) => s.name),
    sharepoint: catalogByKind('sharepoint').map((s) => s.name),
    printers: catalogByKind('printer').map((p) => p.name),
    // Computers by purchase tier (with price), matching the asset library's cost model.
    computers: computerTierList(),
    dockPrice: DOCK_PRICE,
  };
  return { offices, positions, catalog };
}

const CLIENT_DIR = path.join(__dirname, '..', '..', '..', 'client');
const router = Router();

/** Serve the intake form for a token. The form reads the token from the URL and calls the API. */
router.get('/intake/:token', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'intake-form.html'));
});

/** Validate a token and return what the form needs to prefill; marks the link opened. */
router.get('/api/intake/:token', (req, res) => {
  const check = resolveToken(req.params.token);
  if (!check.ok) return res.status(410).json({ ok: false, reason: check.reason });
  markOpened(req.params.token);
  const l = check.link;
  const hire = boundHire(l); // the confirmed BambooHR hire this link is for (null for a freehand link)
  res.json({ ok: true, hire, job_title: l.job_title || (hire ? hire.job_position : null), office: l.office || (hire ? hire.office : null), recipient_name: l.recipient_name, expires_at: l.expires_at, ...intakeOptions() });
});

/** Submit the form for a token. Single-use: creates the onboarding request and closes the link. */
router.post('/api/intake/:token', (req, res) => {
  const out = submitIntake(req.params.token, (req.body && req.body.vals) || req.body || {});
  if (!out.ok) return res.status(out.reason === 'name_required' ? 400 : 410).json({ ok: false, reason: out.reason });
  res.json({ ok: true, request_id: out.request_id, teams: out.teams });
});

export default router;
