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

import { gate, handleLogin, handleLogout, authRequired } from './auth';
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
import { detectExceptions } from './os/exceptions';
import { seedPeopleCatalog } from './people/service';
import { seedOnboardingCatalog } from './services/onboardingCatalog';
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
// Make the configured bootstrap admin a real, durable app_users row so People is authorized the
// moment they complete Microsoft sign-in, and they appear in Access & roles.
ensureBootstrapAdmin();
// Backfill agents for any build order that shipped before the roster existed, so a shipped
// card never claims "live in the roster" without a real agent behind it.
const healed = healRoster();
if (healed) console.log(`[harness] healed ${healed} shipped build order(s) into live agents`);

const app = express();
app.use(express.json({ limit: '5mb' }));

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

// ---- client pages (same-origin iframes so postMessage nav + persistent audio work) ----
const page = (name: string) => (_req: express.Request, res: express.Response) => {
  // App shells are auth-gated and data-driven - never let a browser (or an iframe) serve a stale
  // copy captured before the session was active. Static assets keep their own caching elsewhere.
  res.setHeader('Cache-Control', 'no-store');
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
