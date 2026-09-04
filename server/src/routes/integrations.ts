import { Router } from 'express';
import { resolveIntegrations } from '../config/integrations';
import { AGENTS } from '../config/agents';
import { listSchedules, setSchedule, runSyncNow } from '../services/syncScheduler';
import { sendMail, mailCredsPresent } from '../services/msGraphMail';
import { senderFor } from '../services/mailSenders';
import { currentContext } from '../os/scope';

const router = Router();

/* ---- Microsoft 365 mail: status + a self-test send so you can verify Mail.Send without a live quote ---- */
router.get('/api/integrations/mail/status', (_req, res) => {
  const s = senderFor('notifications') || senderFor('proposals');
  res.json({ ok: true, credsPresent: mailCredsPresent(), from: s?.address || null, fromName: s?.name || null });
});

router.post('/api/integrations/mail/test', async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ ok: false, error: 'Enter a valid recipient email.' });
  const sender = senderFor('notifications') || senderFor('proposals');
  if (!sender || !sender.address) return res.status(400).json({ ok: false, error: 'No sending mailbox is configured. Set MS_MAIL_FROM or a purpose sender.' });
  const who = currentContext(req).user?.display_name || currentContext(req).user?.email || 'the OS';
  const when = new Date().toLocaleString('en-US');
  const html = `<div style="font-family:Calibri,Segoe UI,sans-serif;color:#1f2430;line-height:1.55;max-width:520px">
    <h2 style="color:#1d2b49;font-size:17px;margin:0 0 8px">Microsoft 365 mail is working</h2>
    <p style="font-size:13px">This is a test message from 1st Fire Protection OS, sent as <b>${sender.address}</b>.</p>
    <p style="font-size:13px">If you can read this, the app's <b>Mail.Send</b> permission and sending mailbox are configured correctly, and quote proposals will send from here.</p>
    <p style="font-size:11.5px;color:#667;margin-top:14px">Requested by ${who} at ${when}.</p>
  </div>`;
  const out = await sendMail(to, 'Test email from 1st Fire Protection OS', html, { from: sender.address, fromName: sender.name });
  res.status(out.ok ? 200 : 400).json(out.ok ? { ok: true, sentTo: to, from: sender.address } : { ok: false, error: out.error });
});

/** The per-integration sync cadence, for the schedule settings panel. */
router.get('/api/sync-schedules', (_req, res) => {
  res.json({ ok: true, schedules: listSchedules() });
});

/** Update one integration's cadence (interval_minutes and/or enabled). */
router.put('/api/sync-schedules/:key', (req, res) => {
  const body = req.body || {};
  const out = setSchedule(req.params.key, {
    interval_minutes: body.interval_minutes != null ? Number(body.interval_minutes) : undefined,
    enabled: body.enabled != null ? !!body.enabled : undefined,
  });
  if (!out) return res.status(404).json({ ok: false, error: 'unknown_integration' });
  res.json({ ok: true, schedule: out });
});

/** Force-sync one integration now. */
router.post('/api/sync-schedules/:key/run', async (req, res) => {
  const out = await runSyncNow(req.params.key);
  if (!out) return res.status(404).json({ ok: false, error: 'unknown_integration' });
  res.json({ ok: out.ok, status: out.status, detail: out.detail });
});

router.get('/api/integrations', (_req, res) => {
  const integrations = resolveIntegrations();
  // group by category for the catalog view
  const byCategory: Record<string, typeof integrations> = {};
  for (const i of integrations) {
    (byCategory[i.category] ||= []).push(i);
  }
  res.json({
    integrations,
    byCategory,
    team: AGENTS.map((a) => ({
      key: a.key,
      name: a.name,
      role: a.role,
      status: a.status,
      connectVia: a.connectVia || [],
    })),
    counts: {
      connected: integrations.filter((i) => i.status === 'connected').length,
      available: integrations.filter((i) => i.status === 'available').length,
      planned: integrations.filter((i) => i.status === 'planned').length,
    },
  });
});

export default router;
