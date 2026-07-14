import express from 'express';
import path from 'path';
import http from 'http';
import { WebSocketServer } from 'ws';

import { initDb } from './db/schema';
import { seed } from './seed/index';
import { reflect } from './services/reflection';
import { runDailyCollection } from './services/collectionWorkflow';
import { syncFromVapi } from './services/receptionist';
import { sendAiosReport } from './services/aiosReport';
import { sttEnabled } from './config/voice';

import health from './routes/health';
import brain from './routes/brain';
import invoices from './routes/invoices';
import reviews from './routes/reviews';
import calls from './routes/calls';
import callWebhook from './routes/callWebhook';
import integrations from './routes/integrations';
import voice from './routes/voice';
import admin from './routes/admin';
import introspect from './routes/introspect';

const PORT = Number(process.env.PORT || 3900);
const CLIENT_DIR = path.resolve(__dirname, '../../client');

// ---- boot the brain ----
initDb();
seed();

const app = express();
app.use(express.json({ limit: '5mb' }));

// ---- API routes ----
app.use(health);
app.use(brain);
app.use(invoices);
app.use(reviews);
app.use(calls);
app.use(callWebhook);
app.use(integrations);
app.use(voice);
app.use(admin);
app.use(introspect);

// ---- client pages (same-origin iframes so postMessage nav + persistent audio work) ----
const page = (name: string) => (_req: express.Request, res: express.Response) =>
  res.sendFile(path.join(CLIENT_DIR, name));

app.get('/', page('shell.html'));
app.get('/shell', page('shell.html'));
app.get('/calls', page('calls.html'));
app.get('/invoices', page('invoices.html'));
app.get('/reviews', page('reviews.html'));
app.get('/integrations', page('integrations.html'));

// static assets (theme.css etc.)
app.use(express.static(CLIENT_DIR));

// ---- server + WS (STT proxy placeholder) ----
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/ws/stt')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!sttEnabled()) {
        // graceful degradation — tell the client to use browser STT and close.
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
// the Email (M365/Gmail) or SMS (Twilio) integration is present — then the same cycle
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

// ---- periodic Vapi backfill (tracking) — only runs when VAPI_API_KEY is present ----
// Complements the real-time webhook + manual Sync button: keeps the dashboard current
// even if a webhook delivery is missed. No-ops (and logs nothing) without the key.
if (process.env.VAPI_API_KEY) {
  const VAPI_SYNC_MS = 1000 * 60 * 5; // every 5 min
  const runSync = () =>
    void syncFromVapi().then((r) => {
      if (r.synced) console.log(`[vapi] auto-sync: ${r.synced} calls`);
      else if (r.error) console.warn(`[vapi] auto-sync error: ${r.error}`);
    });
  runSync(); // initial backfill on boot
  setInterval(runSync, VAPI_SYNC_MS).unref();
  console.log('[vapi] tracking enabled — auto-syncing calls every 5 min');
}

server.listen(PORT, () => {
  console.log(`\n  1st FP Operating System`);
  console.log(`  ▸ http://localhost:${PORT}`);
  console.log(`  ▸ client: ${CLIENT_DIR}`);
  console.log(`  ▸ tabs: /calls (home) /invoices /reviews /integrations\n`);
});
