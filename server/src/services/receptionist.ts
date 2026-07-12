import { getDb } from '../db/index';
import { chat } from './llm';
import { telephonyEnabled } from '../config/voice';

/**
 * Call Receptionist engine. Built now; NO-OP until a voice provider key is present.
 * When VAPI_API_KEY / TWILIO_* arrive, it goes live with no code change.
 */

export interface Lead {
  name?: string;
  phone?: string;
  address?: string;
  need?: string;
  source?: string;
}

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

/** Handle a provider end-of-call-report. Logs the call + extracts a lead. */
export async function handleEndOfCall(report: {
  from_number?: string;
  duration?: number;
  transcript?: string;
  intent?: string;
  outcome?: string;
  started_at?: string;
  vapi_id?: string;
}): Promise<{ callId: number; leadId: number | null; live: boolean }> {
  const db = getDb();
  const transcript = report.transcript || '';

  // Dedup with the pull-sync: if this Vapi call was already stored, update it in place.
  if (report.vapi_id) {
    const existing = db.prepare('SELECT id FROM calls WHERE vapi_id = ?').get(report.vapi_id) as
      | { id: number }
      | undefined;
    if (existing) {
      db.prepare(
        `UPDATE calls SET from_number=?, started_at=?, duration=?, transcript=?, intent=?, outcome=?
         WHERE id=?`
      ).run(
        report.from_number || null,
        report.started_at || new Date().toISOString(),
        report.duration || 0,
        transcript,
        report.intent || null,
        report.outcome || 'message',
        existing.id
      );
      return { callId: existing.id, leadId: null, live: telephonyEnabled() };
    }
  }

  const info = db
    .prepare(
      `INSERT INTO calls (from_number, started_at, duration, transcript, intent, outcome, vapi_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'webhook')`
    )
    .run(
      report.from_number || null,
      report.started_at || new Date().toISOString(),
      report.duration || 0,
      transcript,
      report.intent || null,
      report.outcome || 'message',
      report.vapi_id || null
    );
  const callId = Number(info.lastInsertRowid);

  let leadId: number | null = null;
  if (transcript) {
    const lead = await extractLead(transcript, report.from_number);
    if (lead.name || lead.need) leadId = captureLead(lead);
  }
  return { callId, leadId, live: telephonyEnabled() };
}

export interface CallMetrics {
  callsToday: number;
  booked: number;
  transferred: number;
  avgDuration: number;
  leadsCaptured: number;
}

export function getCallMetrics(): CallMetrics {
  const db = getDb();
  const today = db
    .prepare(`SELECT COUNT(*) AS c FROM calls WHERE date(started_at) = date('now')`)
    .get() as { c: number };
  const booked = db.prepare(`SELECT COUNT(*) AS c FROM calls WHERE outcome = 'booked'`).get() as {
    c: number;
  };
  const transferred = db
    .prepare(`SELECT COUNT(*) AS c FROM calls WHERE outcome = 'transferred'`)
    .get() as { c: number };
  const avg = db.prepare(`SELECT COALESCE(AVG(duration),0) AS a FROM calls`).get() as { a: number };
  const leads = db.prepare(`SELECT COUNT(*) AS c FROM leads`).get() as { c: number };
  return {
    callsToday: today.c,
    booked: booked.c,
    transferred: transferred.c,
    avgDuration: Math.round(avg.a),
    leadsCaptured: leads.c,
  };
}
