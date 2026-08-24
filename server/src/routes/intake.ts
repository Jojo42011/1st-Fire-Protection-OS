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
import { computerTierList, DOCK_PRICE, getRequest } from '../services/onboardingAgent';
import { notifyOwners } from '../services/onboardingOwners';
import { sendMail, mailCredsPresent } from '../services/msGraphMail';
import { senderFor } from '../services/mailSenders';
import { intakeSubmittedHtml } from '../services/onboardingEmail';

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
router.post('/api/intake/:token', async (req, res) => {
  const link = resolveToken(req.params.token); // capture the bound hire before the link is closed
  const out = submitIntake(req.params.token, (req.body && req.body.vals) || req.body || {});
  if (!out.ok) {
    const status = out.reason === 'name_required' ? 400 : out.reason === 'create_failed' ? 500 : 410;
    return res.status(status).json({ ok: false, reason: out.reason });
  }
  // Heads-up to the onboarding mailbox so the owning teams know a request is waiting. Keyless-safe:
  // a no-op when mail is not connected, and never blocks or fails the submission for the manager.
  const base = `${req.protocol}://${req.get('host')}`;
  void notifyOnboardingTeams(out, link.ok ? link.link : null, base).catch(() => {});
  // Route each owner lane's tasks to its address (hr@, IT MSP, accounting). Best-effort, keyless-safe.
  if (out.request_id) { const r = getRequest(out.request_id); if (r) void notifyOwners(r.request, r.groups.flatMap((g) => g.items), base).catch(() => {}); }
  res.json({ ok: true, request_id: out.request_id, teams: out.teams });
});

/** Email the onboarding mailbox a summary of a fresh submission. Best-effort; failures are swallowed. */
async function notifyOnboardingTeams(
  out: { request_id: number; teams: string[] },
  link: { job_title: string | null; office: string | null; recipient_name: string | null; employee_id: number | null } | null,
  base: string,
): Promise<void> {
  if (!mailCredsPresent()) return;
  const sender = senderFor('onboarding');
  if (!sender || !sender.address) return;
  const hire = link ? boundHire(link) : null;
  const row = getDb().prepare(`SELECT name, job_position, start_date, manager_name FROM onboarding_requests WHERE id = ?`).get(out.request_id) as
    | { name: string; job_position: string | null; start_date: string | null; manager_name: string | null }
    | undefined;
  if (!row) return;
  const html = intakeSubmittedHtml({
    hireName: row.name,
    role: row.job_position || (link ? link.job_title : null),
    office: (link ? link.office : null) || (hire ? hire.office : null),
    start: row.start_date,
    manager: row.manager_name || (link ? link.recipient_name : null),
    teams: out.teams || [],
    boardUrl: `${base}/onboarding`,
  });
  await sendMail(sender.address, `Onboarding intake submitted: ${row.name}`, html, { from: sender.address, fromName: sender.name });
}

export default router;
