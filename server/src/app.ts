import './config/demo'; // MUST be first: strips external creds + redirects db when DEMO_MODE is on
import express from 'express';
import path from 'path';
import http from 'http';
import { WebSocketServer } from 'ws';

import { initDb } from './db/schema';
import { seed } from './seed/index';
import { reflect } from './services/reflection';
import { runDailyCollection } from './services/collectionWorkflow';
import { sendAiosReport } from './services/aiosReport';
import { sttEnabled } from './config/voice';
import { runDueReports } from './services/reportScheduler';
import { runDueSyncs } from './services/syncScheduler';
import { processLicenseQueue } from './services/entraLicensing';

import { gate, handleLogin, handleLogout, authRequired } from './auth';
import { currentContext } from './os/scope';
import { moduleLevel } from './people/permissions';
import health from './routes/health';
import brain from './routes/brain';
import invoices from './routes/invoices';
import reviews from './routes/reviews';
import calls from './routes/calls';
import impact from './routes/impact';
import callWebhook from './routes/callWebhook';
import integrations from './routes/integrations';
import voice from './routes/voice';
import audit from './routes/audit';
import harness from './routes/harness';
import { healRoster } from './services/harness';
import roster from './routes/roster';
import department from './routes/department';
import admin from './routes/admin';
import introspect from './routes/introspect';
import operator from './routes/operator';
import licenses from './routes/licenses';
import onboarding from './routes/onboarding';
import intake from './routes/intake';
import nav from './routes/nav';
import approvals from './routes/approvals';
import home from './routes/home';
import crm from './routes/crm';
import sync from './routes/sync';
import estimating from './routes/estimating';
import closer from './routes/closer';
import plans from './routes/plans';
import schedule from './routes/schedule';
import costing from './routes/costing';
import settings from './routes/settings';
import servicetradeWebhook from './routes/servicetradeWebhook';
import partner from './routes/partner';
import proposal from './routes/proposal';
import offices from './routes/offices';
import teams from './routes/teams';
import oncall from './routes/oncall';
import deficiencies from './routes/deficiencies';
import scorecard from './routes/scorecard';
import people from './routes/people';
import me from './routes/me';
import sources from './routes/sources';
import reports from './routes/reports';
import exceptions from './routes/exceptions';
import work from './routes/work';
import operations from './routes/operations';
import sharepoint from './routes/sharepoint';
import google from './routes/google';
import adAgent from './routes/agent';
import offboarding from './routes/offboarding';
import sage from './routes/sage';
import { detectExceptions } from './os/exceptions';
import { seedPeopleCatalog } from './people/service';
import { seedOnboardingCatalog, seedPrinterGroups } from './services/onboardingCatalog';
import { seedSoftwareApps } from './services/softwareLicenses';
import { seedMailSenders } from './services/mailSenders';
import { ensureBootstrapAdmin } from './people/authz';
import { cleanupDemoData } from './seed/cleanupDemo';

const PORT = Number(process.env.PORT || 3900);
const CLIENT_DIR = path.resolve(__dirname, '../../client');

// ---- boot the brain ----
initDb();
seed();
// Remove fixture rows that early, ungated builds wrote to the live database (production only, once).
cleanupDemoData();
// Seed the People config catalogs (real job positions + role templates). Idempotent, not demo data.
seedPeopleCatalog();
// Seed the editable onboarding form catalog (computers, software, SharePoint, printers). Idempotent.
seedOnboardingCatalog();
// Seed the per-office printer Entra security groups (SG-PR-<office>). Idempotent.
seedPrinterGroups();
// Seed the starter software-app catalog (Adobe, Bluebeam, HydraCAD, AutoCAD). Idempotent, editable.
seedSoftwareApps();
// Seed the per-purpose mail senders (onboarding@, reviews@, ap@, ...). Idempotent, editable.
seedMailSenders();
// Make the configured bootstrap admin a real, durable app_users row so People is authorized the
// moment they complete Microsoft sign-in, and they appear in Access & roles.
ensureBootstrapAdmin();
// Backfill agents for any build order that shipped before the roster existed, so a shipped
// card never claims "live in the roster" without a real agent behind it.
const healed = healRoster();
if (healed) console.log(`[harness] healed ${healed} shipped build order(s) into live agents`);

const app = express();
app.use(express.json({ limit: '5mb' }));

// ---- canonical host redirect ----
// Browser page loads that arrive on the raw *.fly.dev host are bounced to the branded domain
// (PUBLIC_BASE_URL) so the address bar shows os.1stfpservices.com. Scoped to GET navigations only:
// /api/* is never redirected, so the Fly health check (/api/health), the OIDC callback
// (/api/people/auth/callback), and the token-gated agent endpoints keep answering on any host.
// Safe only because ENTRA_REDIRECT_URI now targets the branded host, so the login cookie is set on
// the same domain the user lands on.
const CANONICAL = (() => { try { return process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL) : null; } catch { return null; } })();
app.use((req, res, next) => {
  if (!CANONICAL || req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  const host = String(req.headers.host || '').toLowerCase();
  if (host && host !== CANONICAL.host && host.endsWith('.fly.dev')) {
    return res.redirect(302, CANONICAL.origin + req.originalUrl);
  }
  next();
});

// ---- password gate (enforced only when APP_PASSWORD is set) ----
app.use(gate);
app.get('/login', (_req, res) => (authRequired() ? res.sendFile(path.join(CLIENT_DIR, 'login.html')) : res.redirect('/')));
app.post('/api/login', handleLogin);
app.post('/api/logout', handleLogout);

// ---- API routes ----
app.use(health);
app.use(brain);
app.use(invoices);
app.use(reviews);
app.use(calls);
app.use(impact);
app.use(callWebhook);
app.use(integrations);
app.use(voice);
app.use(audit);
app.use(harness);
app.use(roster);
app.use(department);
app.use(admin);
app.use(introspect);
app.use(operator);
app.use(licenses);
app.use(onboarding);
app.use(intake);
app.use(nav);
app.use(approvals);
app.use(home);
app.use(crm);
app.use(sync);
app.use(estimating);
app.use(closer);
app.use(plans);
app.use(schedule);
app.use(costing);
app.use(settings);
app.use(servicetradeWebhook);
app.use(partner);
app.use(proposal);
app.use(offices);
app.use(teams);
app.use(oncall);
app.use(deficiencies);
app.use(scorecard);
app.use(people);
app.use(me);
app.use(sources);
app.use(reports);
app.use(exceptions);
app.use(work);
app.use(operations);
app.use(sharepoint);
app.use(google);
app.use(adAgent);
app.use(offboarding);
app.use(sage);

// ---- client pages (same-origin iframes so postMessage nav + persistent audio work) ----
//
// Which People module governs each screen. A People-authorized session that lacks view access
// (level >= 1) on a screen's module is refused the page outright, so direct-URL navigation can't
// bypass the hidden nav item. Screens not listed here (the shell container, personal pages like
// My Tasks, /soon) are always served. Legacy shared-password sessions have no People identity and
// keep the full shell: the wider OS is gated by APP_PASSWORD, People roles refine it.
const PAGE_MODULE: Record<string, string> = {
  'operator.html': 'overview', 'home.html': 'overview',
  'approvals.html': 'overview', 'exceptions.html': 'overview',
  'money.html': 'receivables', 'receivables.html': 'receivables', 'invoices.html': 'receivables', 'close.html': 'accounting',
  'service.html': 'service', 'schedule.html': 'service', 'deficiencies.html': 'deficiencies',
  'ops-jobs.html': 'service', 'jobs.html': 'service', 'agreements.html': 'service', 'costing.html': 'service',
  'calls.html': 'service', 'reviews-hub.html': 'service', 'reviews.html': 'service',
  'review-requests.html': 'service', 'oncall.html': 'service', 'plans.html': 'service',
  'people.html': 'people', 'onboarding.html': 'people', 'offboarding.html': 'people',
  'accounts.html': 'service', 'sites.html': 'service', 'quotes.html': 'deficiencies',
  'pipeline.html': 'deficiencies', 'closer.html': 'deficiencies', 'estimates.html': 'deficiencies',
  'account.html': 'service',
  'executive.html': 'overview', 'office-performance.html': 'overview', 'scoreboard.html': 'overview',
  'reports-money.html': 'accounting', 'reports-ops.html': 'service', 'reports-people.html': 'people',
  'reports-builder.html': 'overview',
  'offices.html': 'overview', 'it-systems.html': 'access', 'licenses.html': 'access',
  'company-integrations.html': 'access', 'integrations.html': 'access', 'sync.html': 'access',
  'access.html': 'access', 'roster.html': 'access', 'harness.html': 'access',
  'department.html': 'access', 'agent.html': 'access', 'ad-audit.html': 'access',
};
const NO_ACCESS_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>No access</title><style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d10;color:#e7ebf0}
.c{max-width:360px;text-align:center;padding:28px}.c h1{font-size:16px;margin:0 0 8px}.c p{font-size:13px;color:#9aa4b2;line-height:1.5;margin:0}</style>
<div class="c"><h1>You do not have access to this area</h1><p>Your role does not include this part of 1st Fire Protection OS. If you think this is a mistake, ask a People admin to adjust your access under Access &amp; Roles.</p></div>`;
const page = (name: string) => (req: express.Request, res: express.Response) => {
  // App shells are auth-gated and data-driven - never let a browser (or an iframe) serve a stale
  // copy captured before the session was active. Static assets keep their own caching elsewhere.
  res.setHeader('Cache-Control', 'no-store');
  const mod = PAGE_MODULE[name];
  if (mod) {
    const ctx = currentContext(req);
    // Enforce only for real People sessions (a mapped identity with roles). Level 0 = refused.
    if (ctx.user && ctx.user.roles.length > 0 && moduleLevel(ctx.user, mod) < 1) {
      res.status(403).send(NO_ACCESS_HTML);
      return;
    }
  }
  res.sendFile(path.join(CLIENT_DIR, name));
};

app.get('/', page('shell.html'));
app.get('/shell', page('shell.html'));
app.get('/operator', page('operator.html'));
app.get('/calls', page('calls.html'));
app.get('/invoices', page('invoices.html'));
app.get('/reviews', page('reviews.html'));
app.get('/review-requests', page('review-requests.html'));
app.get('/reviews-hub', page('reviews-hub.html'));
app.get('/executive', page('executive.html'));
app.get('/harness', page('harness.html'));
app.get('/roster', page('roster.html'));
app.get('/department', page('department.html'));
app.get('/agent', page('agent.html'));
app.get('/ad-audit', page('ad-audit.html'));
app.get('/sp-access', page('sp-access.html'));
app.get('/offboarding', page('offboarding.html'));
app.get('/integrations', page('integrations.html'));
app.get('/licenses', page('licenses.html'));
app.get('/onboarding', page('onboarding.html'));
app.get('/soon', page('soon.html'));
app.get('/home', page('home.html'));
app.get('/approvals', page('approvals.html'));
app.get('/accounts', page('accounts.html'));
app.get('/sites', page('sites.html'));
app.get('/jobs', page('jobs.html'));
app.get('/quotes', page('quotes.html'));
app.get('/account', page('account.html'));
app.get('/pipeline', page('pipeline.html'));
app.get('/sync', page('sync.html'));
app.get('/estimates', page('estimates.html'));
app.get('/closer', page('closer.html'));
app.get('/plans', page('plans.html'));
app.get('/schedule', page('schedule.html'));
app.get('/costing', page('costing.html'));
app.get('/oncall', page('oncall.html'));
app.get('/deficiencies', page('deficiencies.html'));
app.get('/scoreboard', page('scoreboard.html'));
app.get('/office-performance', page('office-performance.html'));
app.get('/exceptions', page('exceptions.html'));
app.get('/reports-builder', page('reports-builder.html'));
app.get('/money', page('money.html'));
app.get('/access', page('access.html'));
app.get('/my-tasks', page('my-tasks.html'));
app.get('/receivables', page('receivables.html'));
app.get('/close', page('close.html'));
app.get('/service', page('service.html'));
app.get('/ops-jobs', page('ops-jobs.html'));
app.get('/agreements', page('agreements.html'));
app.get('/reports-ops', page('reports-ops.html'));
app.get('/reports-money', page('reports-money.html'));
app.get('/reports-people', page('reports-people.html'));
app.get('/offices', page('offices.html'));
app.get('/it-systems', page('it-systems.html'));
app.get('/company-integrations', page('company-integrations.html'));
app.get('/people', page('people.html'));

// static assets (theme.css etc.)
// Serve assets with revalidation, not long-lived caching. os.css/os.js and the other shared assets
// change on every deploy; without this a browser keeps an old copy and the UI looks stale (a fixed
// layout still renders with last week's stylesheet). no-cache = use the cache only after the server
// confirms it is unchanged (a cheap 304), so updates always land on the next load.
app.use(
  express.static(CLIENT_DIR, {
    setHeaders: (res, filePath) => {
      if (/\.(css|js|mjs|html)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// ---- server + WS (STT proxy placeholder) ----
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/ws/stt')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!sttEnabled()) {
        // graceful degradation - tell the client to use browser STT and close.
        ws.send(JSON.stringify({ type: 'degraded', reason: 'no ELEVENLABS_API_KEY' }));
        ws.close();
        return;
      }
      // A live STT proxy would pipe audio frames to the provider here.
      ws.on('message', () => ws.send(JSON.stringify({ type: 'partial', text: '' })));
    });
  } else {
    socket.destroy();
  }
});

// ---- periodic reflection (self-insight) ----
const REFLECT_MS = 1000 * 60 * 30; // every 30 min
setInterval(() => {
  void reflect();
}, REFLECT_MS).unref();

// ---- invoice collection workflow (daily dunning until paid) ----
// Checks hourly; per-invoice next_run_at gating means each enrolled invoice only gets
// its email+text once a day until it's marked paid. Sends are simulated (logged) until
// the Email (M365/Gmail) or SMS (Twilio) integration is present - then the same cycle
// sends for real. Never throws; a missing integration just no-ops the send.
const COLLECTION_MS = 1000 * 60 * 60; // check every hour, act once per day per invoice
const runCollection = () =>
  void runDailyCollection()
    .then((r) => {
      if (r.processed) {
        console.log(
          `[collection] daily cycle: ${r.processed} invoices · ${r.sent} sent · ${r.simulated} simulated · ${r.completed} completed`
        );
      }
    })
    .catch((err) => console.warn('[collection] cycle error:', (err as Error).message));
runCollection(); // kick any due cycles shortly after boot
setInterval(runCollection, COLLECTION_MS).unref();

// ---- daily Booker Growth report (introspection push) ----
// Silent no-op unless AIOS_REPORT_URL + AIOS_REPORT_KEY are both set; failures are
// logged and swallowed so reporting can never affect the app itself.
const AIOS_REPORT_MS = 1000 * 60 * 60 * 24; // daily
setTimeout(() => void sendAiosReport(), 1000 * 60).unref(); // first report ~1 min after boot
setInterval(() => void sendAiosReport(), AIOS_REPORT_MS).unref();

// ---- configurable per-integration sync scheduler ----
// One master tick a minute runs each integration (ServiceTrade, BambooHR, Microsoft/vendor seats,
// phone receptionist) when it is due, at the cadence the operator sets on the Integrations screen.
// Defaults match the previous hardcoded rates (ServiceTrade 15m, calls 5m). All sync calls are
// keyless-safe and never throw, so a missing credential is a graceful no-op. ServiceTrade's cycle
// also refreshes the exceptions queue.
const SYNC_TICK_MS = 1000 * 60; // check every minute; each integration runs on its own cadence
setTimeout(() => { void runDueSyncs(); }, 1000 * 60).unref(); // first pass ~60s after boot
setInterval(() => { void runDueSyncs(); }, SYNC_TICK_MS).unref();
// One detection pass at boot so the exceptions queue is populated before the first sync cycle.
setTimeout(() => { try { detectExceptions(); } catch (e) { console.warn('[exceptions] boot detect error:', (e as Error).message); } }, 1000 * 8).unref();

// Entra license assignment: retry the queue every few minutes until each new hire's account has
// synced to Entra and its license lands. Keyless-safe: a no-op when Graph is not connected.
const LICENSE_MS = 1000 * 60 * 5;
setInterval(() => {
  void processLicenseQueue()
    .then((r) => { if (r.assigned) console.log(`[license] assigned ${r.assigned} Entra license(s)`); })
    .catch((e) => console.warn('[license] queue error:', (e as Error).message));
}, LICENSE_MS).unref();

// Scheduled-report delivery: check hourly for saved reports that are due and email them.
const REPORTS_MS = 60 * 60 * 1000;
const runReports = () => runDueReports()
  .then((r) => { if (r.sent) console.log(`[reports] delivered ${r.sent} scheduled report(s)`); })
  .catch((e) => console.warn('[reports] scheduler error:', (e as Error).message));
setInterval(runReports, REPORTS_MS).unref();

server.listen(PORT, () => {
  console.log(`\n  Northstar Operating System`);
  console.log(`  ▸ http://localhost:${PORT}`);
  console.log(`  ▸ client: ${CLIENT_DIR}`);
  console.log(`  ▸ tabs: /calls (home) /invoices /reviews /integrations\n`);
});
