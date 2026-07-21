import { Router } from 'express';
import { getDb } from '../db/index';
import { getCallMetrics, syncFromVapi, getFreshRecording } from '../services/receptionist';
import { telephonyEnabled } from '../config/voice';

const router = Router();

/** Parse the JSON-stringified columns back into objects for the client. */
function hydrate(row: any): any {
  const parse = (v: unknown) => {
    if (typeof v !== 'string' || !v) return v ?? null;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  return {
    ...row,
    messages: parse(row.messages),
    cost_breakdown: parse(row.cost_breakdown),
    structured_data: parse(row.structured_data),
  };
}

router.get('/api/calls', (_req, res) => {
  const db = getDb();
  const calls = (db.prepare(`SELECT * FROM calls ORDER BY started_at DESC`).all() as any[]).map(hydrate);
  const leads = db.prepare(`SELECT * FROM leads ORDER BY created_at DESC`).all();
  res.json({
    metrics: getCallMetrics(),
    calls,
    leads,
    live: telephonyEnabled(),
  });
});

/** Backfill recent calls from Vapi's REST API (uses VAPI_API_KEY). Graceful no-op without a key. */
router.post('/api/calls/sync', async (req, res) => {
  const limit = Number(req.body?.limit) || 100;
  const result = await syncFromVapi(limit);
  res.json({ ok: !result.error, ...result });
});

/**
 * Recording proxy — the audio player points here, not at the raw stored URL.
 * Re-pulls the freshest URL from Vapi at play time and 302s to it when it's readable,
 * so links never go stale. Returns 409 with a reason when the recording is locked in
 * Vapi's private (HIPAA) storage, which the UI turns into a clear note.
 */
router.get('/api/calls/:id/recording', async (req, res) => {
  const row = getDb().prepare(`SELECT vapi_call_id, recording_url FROM calls WHERE id = ?`).get(Number(req.params.id)) as
    | { vapi_call_id: string | null; recording_url: string | null }
    | undefined;
  if (!row) return res.status(404).json({ ok: false, reason: 'not-found' });
  const stereo = String(req.query.stereo || '') === '1';

  // Live path: re-pull a fresh URL and verify it's readable.
  if (row.vapi_call_id) {
    const fresh = await getFreshRecording(row.vapi_call_id, stereo);
    if (fresh.ok && fresh.url) return res.redirect(302, fresh.url);
    if (fresh.reason === 'locked')
      return res.status(409).json({ ok: false, reason: 'locked', message: 'Recording is in Vapi private (HIPAA) storage — enable public/BYO storage in Vapi to play it here.' });
    // no key / not-found → fall through to whatever we stored
  }
  // Fallback: the stored URL (works for seeded/demo rows and non-HIPAA public URLs).
  if (row.recording_url) return res.redirect(302, row.recording_url);
  return res.status(404).json({ ok: false, reason: 'no-recording' });
});

/** TEMP DIAGNOSTIC — dump what Vapi actually returns for one call's recording fields. */
router.get('/api/calls/:id/recording-debug', async (req, res) => {
  const key = process.env.VAPI_API_KEY;
  if (!key) return res.json({ ok: false, reason: 'no-key' });
  const row = getDb().prepare(`SELECT vapi_call_id FROM calls WHERE id = ?`).get(Number(req.params.id)) as
    | { vapi_call_id: string | null }
    | undefined;
  if (!row?.vapi_call_id) return res.json({ ok: false, reason: 'no-vapi-id' });
  try {
    const r = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(row.vapi_call_id)}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const j: any = await r.json();
    const art = j?.artifact || {};
    res.json({
      status: r.status,
      recordingUrl: j?.recordingUrl,
      stereoRecordingUrl: j?.stereoRecordingUrl,
      artifact_recordingUrl: art?.recordingUrl,
      artifact_stereoRecordingUrl: art?.stereoRecordingUrl,
      artifact_recording: art?.recording,
      artifactPlan: j?.artifactPlan,
      artifact_keys: Object.keys(art),
    });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message });
  }
});

/** Update a lead's status (in-house / reversible). */
router.post('/api/calls/leads/:id/status', (req, res) => {
  const status = String(req.body?.status || 'new');
  getDb().prepare(`UPDATE leads SET status = ? WHERE id = ?`).run(status, Number(req.params.id));
  res.json({ ok: true, status });
});

export default router;
