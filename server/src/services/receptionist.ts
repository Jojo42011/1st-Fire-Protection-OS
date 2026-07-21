import { getDb } from '../db/index';
import { chat } from './llm';
import { telephonyEnabled } from '../config/voice';

/**
 * Call Receptionist engine. Built now; NO-OP until a voice provider key is present.
 * When VAPI_API_KEY / TWILIO_* arrive, it goes live with no code change.
 *
 * Two ingest paths, one normalizer:
 *  - push: Vapi posts an `end-of-call-report` to /api/webhooks/call (real time).
 *  - pull: /api/calls/sync backfills from Vapi's REST API using VAPI_API_KEY.
 * Both feed `normalizeVapiCall()` → `upsertCall()` so a call is stored once with the
 * full artifact (transcript, recording, messages, cost breakdown, analysis).
 */

export interface Lead {
  name?: string;
  phone?: string;
  address?: string;
  need?: string;
  source?: string;
}

/** A fully-resolved call row, provider-agnostic. */
export interface CallRecord {
  vapi_call_id?: string;
  assistant_id?: string;
  from_number?: string;
  started_at?: string;
  ended_at?: string;
  duration?: number; // seconds
  ended_reason?: string;
  transcript?: string;
  summary?: string;
  messages?: unknown;
  recording_url?: string;
  stereo_recording_url?: string;
  cost?: number;
  cost_breakdown?: unknown;
  success_evaluation?: string;
  structured_data?: Record<string, unknown> | null;
  intent?: string;
  outcome?: string;
}

/* ---------- lead extraction ---------- */

/** Extract a structured lead from a call transcript via the LLM (keyword fallback). */
export async function extractLead(transcript: string, fromNumber?: string): Promise<Lead> {
  const fallback: Lead = {
    phone: fromNumber,
    source: 'phone',
    need: transcript.slice(0, 140),
  };

  const result = await chat(
    [
      {
        role: 'system',
        content:
          'Extract a lead from this fire-protection company call transcript. Return ONLY JSON: {"name","phone","address","need"}. Use empty strings for unknown fields.',
      },
      { role: 'user', content: transcript.slice(0, 4000) },
    ],
    { fast: true, maxTokens: 300 }
  );

  if (!result || !result.text) return fallback;
  try {
    const parsed = JSON.parse(result.text.replace(/```json|```/g, '').trim());
    return {
      name: parsed.name || undefined,
      phone: parsed.phone || fromNumber,
      address: parsed.address || undefined,
      need: parsed.need || transcript.slice(0, 140),
      source: 'phone',
    };
  } catch {
    return fallback;
  }
}

export function captureLead(lead: Lead): number {
  const info = getDb()
    .prepare(
      `INSERT INTO leads (name, phone, address, need, source, status) VALUES (?, ?, ?, ?, ?, 'new')`
    )
    .run(lead.name || null, lead.phone || null, lead.address || null, lead.need || null, lead.source || 'phone');
  return Number(info.lastInsertRowid);
}

export function bookInspection(lead: Lead): number {
  const info = getDb()
    .prepare(
      `INSERT INTO leads (name, phone, address, need, source, status) VALUES (?, ?, ?, ?, ?, 'booked')`
    )
    .run(lead.name || null, lead.phone || null, lead.address || null, lead.need || 'inspection', lead.source || 'phone');
  return Number(info.lastInsertRowid);
}

/* ---------- Vapi normalization ---------- */

function firstStr(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

/** Map Vapi endedReason → our call outcome (booked|message|transferred|missed). */
function deriveOutcome(endedReason?: string, structured?: Record<string, unknown> | null): string {
  const fromData = structured && typeof structured.outcome === 'string' ? String(structured.outcome) : '';
  if (fromData) return fromData;
  const r = (endedReason || '').toLowerCase();
  if (r.includes('forward') || r.includes('transfer')) return 'transferred';
  if (r.includes('no-answer') || r.includes('voicemail') || r.includes('busy') || r.includes('no-response'))
    return 'missed';
  return 'message';
}

/**
 * Normalize either a webhook `message` object (end-of-call-report) or a REST call
 * object (GET /call) into a CallRecord. Reads defensively from message / call /
 * artifact / analysis so it survives Vapi field-location changes across versions.
 */
export function normalizeVapiCall(src: any): CallRecord {
  const call = src?.call || {};
  const artifact = src?.artifact || call?.artifact || {};
  const analysis = src?.analysis || call?.analysis || {};
  const recording = artifact?.recording || {};
  const costBreakdown = src?.costBreakdown ?? call?.costBreakdown;

  const startedAt = firstStr(src?.startedAt, call?.startedAt, src?.started_at, call?.createdAt);
  const endedAt = firstStr(src?.endedAt, call?.endedAt, src?.ended_at);

  let duration: number | undefined =
    typeof src?.durationSeconds === 'number'
      ? src.durationSeconds
      : typeof src?.duration === 'number'
      ? src.duration
      : undefined;
  if (duration === undefined && startedAt && endedAt) {
    const d = (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000;
    if (isFinite(d) && d >= 0) duration = Math.round(d);
  }

  const structured_data = (analysis?.structuredData as Record<string, unknown>) || null;
  const ended_reason = firstStr(src?.endedReason, call?.endedReason);

  return {
    vapi_call_id: firstStr(src?.id, call?.id, src?.callId),
    assistant_id: firstStr(src?.assistantId, call?.assistantId),
    from_number: firstStr(
      src?.customer?.number,
      call?.customer?.number,
      src?.phoneNumber?.number,
      src?.from_number,
      src?.from
    ),
    started_at: startedAt,
    ended_at: endedAt,
    duration: duration ?? 0,
    ended_reason,
    transcript: firstStr(src?.transcript, artifact?.transcript) || '',
    summary: firstStr(src?.summary, analysis?.summary, artifact?.summary),
    messages: src?.messages || artifact?.messages || undefined,
    // Vapi returns BOTH a bare storage path (recordingUrl — not directly readable, 400)
    // and short-lived PRESIGNED URLs. Prefer the presigned ones; the play-time proxy
    // re-pulls a fresh call so these never serve stale/expired.
    recording_url: firstStr(
      artifact?.presignedMonoUrl,
      artifact?.presignedUrl,
      src?.recordingUrl,
      artifact?.recordingUrl,
      recording?.mono?.combinedUrl,
      recording?.combinedUrl,
      recording?.url
    ),
    stereo_recording_url: firstStr(
      artifact?.presignedStereoUrl,
      src?.stereoRecordingUrl,
      artifact?.stereoRecordingUrl,
      recording?.stereoUrl
    ),
    cost: typeof src?.cost === 'number' ? src.cost : typeof call?.cost === 'number' ? call.cost : 0,
    cost_breakdown: costBreakdown,
    success_evaluation:
      analysis?.successEvaluation !== undefined ? String(analysis.successEvaluation) : undefined,
    structured_data,
    intent: firstStr(structured_data?.intent as string, src?.intent, analysis?.intent),
    outcome: deriveOutcome(ended_reason, structured_data),
  };
}

const toJson = (v: unknown): string | null =>
  v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v);

/** Insert or update a call row keyed on vapi_call_id. Returns whether it was newly inserted. */
export function upsertCall(rec: CallRecord): { id: number; inserted: boolean } {
  const db = getDb();
  const vals = [
    rec.vapi_call_id || null,
    rec.assistant_id || null,
    rec.from_number || null,
    rec.started_at || new Date().toISOString(),
    rec.ended_at || null,
    rec.duration || 0,
    rec.transcript || '',
    rec.intent || null,
    rec.outcome || 'message',
    rec.ended_reason || null,
    rec.cost || 0,
    toJson(rec.cost_breakdown),
    rec.summary || null,
    toJson(rec.messages),
    rec.recording_url || null,
    rec.stereo_recording_url || null,
    rec.success_evaluation || null,
    toJson(rec.structured_data),
  ];

  if (rec.vapi_call_id) {
    const existing = db.prepare(`SELECT id FROM calls WHERE vapi_call_id = ?`).get(rec.vapi_call_id) as
      | { id: number }
      | undefined;
    if (existing) {
      db.prepare(
        `UPDATE calls SET
           assistant_id=?, from_number=?, started_at=?, ended_at=?, duration=?,
           transcript=?, intent=?, outcome=?, ended_reason=?, cost=?, cost_breakdown=?,
           summary=?, messages=?, recording_url=?, stereo_recording_url=?,
           success_evaluation=?, structured_data=?
         WHERE id=?`
      ).run(...vals.slice(1), existing.id);
      return { id: existing.id, inserted: false };
    }
  }

  const info = db
    .prepare(
      `INSERT INTO calls
         (vapi_call_id, assistant_id, from_number, started_at, ended_at, duration,
          transcript, intent, outcome, ended_reason, cost, cost_breakdown,
          summary, messages, recording_url, stereo_recording_url,
          success_evaluation, structured_data)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(...vals);
  return { id: Number(info.lastInsertRowid), inserted: true };
}

/** Ingest one raw Vapi call (webhook message OR REST call object): store + extract a lead. */
export async function ingestVapiCall(
  raw: any
): Promise<{ callId: number; leadId: number | null; inserted: boolean; live: boolean }> {
  const rec = normalizeVapiCall(raw);
  const { id: callId, inserted } = upsertCall(rec);

  // Extract a lead only on first ingest, so webhook re-deliveries don't duplicate leads.
  let leadId: number | null = null;
  if (inserted && rec.transcript) {
    const lead = await extractLead(rec.transcript, rec.from_number);
    if (lead.name || lead.need) leadId = captureLead(lead);
  }
  return { callId, leadId, inserted, live: telephonyEnabled() };
}

/**
 * Pull recent calls from Vapi's REST API and backfill them. Graceful no-op without a key.
 * Lets the dashboard populate from existing call history instead of waiting for new calls.
 */
export async function syncFromVapi(limit = 100): Promise<{ synced: number; live: boolean; error?: string }> {
  const key = process.env.VAPI_API_KEY;
  if (!key) return { synced: 0, live: false };
  try {
    const res = await fetch(`https://api.vapi.ai/call?limit=${Math.min(limit, 1000)}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) return { synced: 0, live: true, error: `vapi ${res.status}: ${await res.text()}` };
    const calls = (await res.json()) as any[];
    if (!Array.isArray(calls)) return { synced: 0, live: true, error: 'unexpected response shape' };

    let synced = 0;
    for (const c of calls) {
      // Skip in-progress calls (no end artifact yet).
      if (!c?.endedAt && !c?.artifact && !c?.transcript) continue;
      await ingestVapiCall(c);
      synced++;
    }
    return { synced, live: true };
  } catch (err) {
    return { synced: 0, live: true, error: (err as Error).message };
  }
}

/**
 * Fetch the FRESHEST recording URL for a single call straight from Vapi, and probe it.
 *
 * Vapi hands back time-limited / storage-scoped recording URLs; the copy we stored at
 * ingest can go stale or (with HIPAA storage on) be a private path the browser can't read.
 * Re-pulling GET /call/{id} at play time gives the newest URL, and a byte probe tells us
 * whether it's actually playable — so the UI can show audio when it can and an honest note
 * when the recording is locked in Vapi's private (HIPAA) bucket.
 */
export async function getFreshRecording(
  vapiCallId: string,
  stereo = false
): Promise<{ url?: string; ok: boolean; reason?: 'no-key' | 'not-found' | 'no-recording' | 'locked' | 'error' }> {
  const key = process.env.VAPI_API_KEY;
  if (!key) return { ok: false, reason: 'no-key' };
  try {
    const res = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(vapiCallId)}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) return { ok: false, reason: 'not-found' };
    const rec = normalizeVapiCall(await res.json());
    const url = stereo ? rec.stereo_recording_url || rec.recording_url : rec.recording_url;
    if (!url) return { ok: false, reason: 'no-recording' };

    // keep the stored copy current
    if (rec.vapi_call_id && (rec.recording_url || rec.stereo_recording_url)) {
      getDb()
        .prepare(`UPDATE calls SET recording_url = COALESCE(?, recording_url), stereo_recording_url = COALESCE(?, stereo_recording_url) WHERE vapi_call_id = ?`)
        .run(rec.recording_url || null, rec.stereo_recording_url || null, rec.vapi_call_id);
    }

    // probe: can anyone actually read it? (HIPAA private buckets answer 400/403 here)
    try {
      const probe = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      if (probe.ok || probe.status === 206) return { url, ok: true };
      return { url, ok: false, reason: 'locked' };
    } catch {
      return { url, ok: false, reason: 'locked' };
    }
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/* ---------- metrics ---------- */

export interface CallMetrics {
  callsToday: number;
  booked: number;
  transferred: number;
  avgDuration: number;
  leadsCaptured: number;
  costToday: number;
  spendTotal: number;
}

export function getCallMetrics(): CallMetrics {
  const db = getDb();
  const one = (sql: string): number => (db.prepare(sql).get() as { v: number }).v;
  return {
    callsToday: one(`SELECT COUNT(*) AS v FROM calls WHERE date(started_at) = date('now')`),
    booked: one(`SELECT COUNT(*) AS v FROM calls WHERE outcome = 'booked'`),
    transferred: one(`SELECT COUNT(*) AS v FROM calls WHERE outcome = 'transferred'`),
    avgDuration: Math.round(one(`SELECT COALESCE(AVG(duration),0) AS v FROM calls`)),
    leadsCaptured: one(`SELECT COUNT(*) AS v FROM leads`),
    costToday: one(`SELECT COALESCE(SUM(cost),0) AS v FROM calls WHERE date(started_at) = date('now')`),
    spendTotal: one(`SELECT COALESCE(SUM(cost),0) AS v FROM calls`),
  };
}
