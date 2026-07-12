import express from 'express';
import path from 'path';
import http from 'http';
import { WebSocketServer } from 'ws';

import { initDb } from './db/schema';
import { seed } from './seed/index';
import { reflect } from './services/reflection';
import { syncFromVapi } from './services/receptionist';
import { runDueReminders } from './services/reminderWorkflow';
import { syncFromServiceTrade } from './services/serviceTrade';
import { sttEnabled } from './config/voice';
import { serviceTradeEnabled, resendEnabled, telnyxEnabled } from './config/comms';

import health from './routes/health';
import brain from './routes/brain';
import invoices from './routes/invoices';
import reviews from './routes/reviews';
import calls from './routes/calls';
import callWebhook from './routes/callWebhook';
import serviceTradeWebhook from './routes/serviceTradeWebhook';
import integrations from './routes/integrations';
import voice from './routes/voice';

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
app.use(serviceTradeWebhook);
app.use(integrations);
app.use(voice);

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

// ---- invoice reminder sweep — the day-1/3/5/7 workflow engine ----
// Runs hourly: sends every reminder whose date has arrived (via Resend/Telnyx) and skips
// steps on invoices that got paid. Always runs so the sequence advances; when comms keys are
// absent, due reminders are drafted and left 'queued' for one-click approval (graceful).
const REMINDER_SWEEP_MS = 1000 * 60 * 60; // hourly
const runReminderSweep = () =>
  void runDueReminders()
    .then((r) => {
      if (r.sent || r.queued || r.failed || r.skipped) {
        console.log(
          `[invoices] reminder sweep — sent:${r.sent} queued:${r.queued} failed:${r.failed} skipped:${r.skipped}`
        );
      }
    })
    .catch((err) => console.warn('[invoices] reminder sweep error:', (err as Error).message));
runReminderSweep(); // initial sweep on boot
setInterval(runReminderSweep, REMINDER_SWEEP_MS).unref();
{
  const email = resendEnabled() ? 'Resend' : 'queued (no RESEND key)';
  const sms = telnyxEnabled() ? 'Telnyx' : 'queued (no TELNYX key)';
  console.log(`[invoices] reminder workflow enabled — hourly sweep · email→${email} · sms→${sms}`);
}

// ---- periodic ServiceTrade backfill — only when SERVICETRADE_TOKEN is present ----
if (serviceTradeEnabled()) {
  const ST_SYNC_MS = 1000 * 60 * 15; // every 15 min
  const runStSync = () =>
    void syncFromServiceTrade().then((r) => {
      if (r.synced) console.log(`[serviceTrade] auto-sync: ${r.synced} invoices`);
      else if (r.error) console.warn(`[serviceTrade] auto-sync error: ${r.error}`);
    });
  runStSync();
  setInterval(runStSync, ST_SYNC_MS).unref();
  console.log('[serviceTrade] tracking enabled — auto-syncing invoices every 15 min');
}

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
