import { getDb } from '../db/index';
import { extractLead, captureLead } from './receptionist';

/**
 * Vapi tracking — PULL side. When VAPI_API_KEY is present, fetch calls from the Vapi REST
 * API and upsert them into the local `calls` table so the dashboard tracks real call activity.
 * Graceful degradation: no key → no-op (never throws).
 *
 * Docs: https://docs.vapi.ai/api-reference/calls/list
 */

const VAPI_BASE = process.env.VAPI_BASE_URL || 'https://api.vapi.ai';

export function vapiEnabled(): boolean {
  return !!process.env.VAPI_API_KEY;
}

interface VapiCall {
  id: string;
  type?: string;
  startedAt?: string;
  endedAt?: string;
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  endedReason?: string;
  cost?: number;
  customer?: { number?: string };
  analysis?: { summary?: string; structuredData?: Record<string, unknown> };
  messages?: { role?: string; message?: string; content?: string }[];
}

/** Map a Vapi endedReason to our coarse outcome bucket. */
function outcomeFor(call: VapiCall): string {
  const sd = call.analysis?.structuredData || {};
  if (typeof sd.outcome === 'string') return sd.outcome;
  const r = (call.endedReason || '').toLowerCase();
  if (r.includes('forward') || r.includes('transfer')) return 'transferred';
  if (r.includes('voicemail')) return 'message';
  if (r.includes('no-answer') || r.includes('did-not-answer') || r.includes('customer-busy')) return 'missed';
  return 'message';
}

function intentFor(call: VapiCall): string {
  const sd = call.analysis?.structuredData || {};
  if (typeof sd.intent === 'string') return sd.intent;
  const s = call.analysis?.summary || call.summary || '';
  return s.split(/[.!?\n]/)[0].slice(0, 80) || 'Inbound call';
}

function durationSeconds(call: VapiCall): number {
  if (!call.startedAt || !call.endedAt) return 0;
  const d = (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000;
  return Number.isFinite(d) && d > 0 ? Math.round(d) : 0;
}

function transcriptFor(call: VapiCall): string {
  if (call.transcript) return call.transcript;
  if (Array.isArray(call.messages) && call.messages.length) {
    return call.messages.map((m) => `${m.role || '?'}: ${m.message || m.content || ''}`).join('\n');
  }
  return call.analysis?.summary || call.summary || '';
}

/** Fetch the most recent calls from Vapi. Returns [] on any error (graceful). */
export async function listVapiCalls(limit = 50): Promise<VapiCall[]> {
  if (!vapiEnabled()) return [];
  try {
    const res = await fetch(`${VAPI_BASE}/call?limit=${limit}`, {
      headers: { authorization: `Bearer ${process.env.VAPI_API_KEY}` },
    });
    if (!res.ok) throw new Error(`vapi ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as VapiCall[] | { results?: VapiCall[] };
    return Array.isArray(data) ? data : data.results || [];
  } catch (err) {
    console.warn('[vapi] list failed:', (err as Error).message);
    return [];
  }
}

export interface SyncResult {
  live: boolean;
  fetched: number;
  inserted: number;
  updated: number;
  leads: number;
}

/**
 * Pull recent Vapi calls and upsert into `calls` (dedup by vapi_id). New calls also get a
 * lead extracted. Safe to run repeatedly and on a cron.
 */
export async function syncVapiCalls(limit = 50): Promise<SyncResult> {
  const result: SyncResult = { live: vapiEnabled(), fetched: 0, inserted: 0, updated: 0, leads: 0 };
  if (!vapiEnabled()) return result;

  const calls = await listVapiCalls(limit);
  result.fetched = calls.length;
  const db = getDb();

  const findByVapi = db.prepare('SELECT id FROM calls WHERE vapi_id = ?');
  const insert = db.prepare(
    `INSERT INTO calls (from_number, started_at, duration, transcript, intent, outcome,
                        vapi_id, summary, recording_url, ended_reason, cost, source)
     VALUES (@from_number, @started_at, @duration, @transcript, @intent, @outcome,
             @vapi_id, @summary, @recording_url, @ended_reason, @cost, 'vapi')`
  );
  const update = db.prepare(
    `UPDATE calls SET from_number=@from_number, started_at=@started_at, duration=@duration,
       transcript=@transcript, intent=@intent, outcome=@outcome, summary=@summary,
       recording_url=@recording_url, ended_reason=@ended_reason, cost=@cost
     WHERE vapi_id=@vapi_id`
  );

  for (const call of calls) {
    if (!call.id) continue;
    const row = {
      from_number: call.customer?.number || null,
      started_at: call.startedAt || new Date().toISOString(),
      duration: durationSeconds(call),
      transcript: transcriptFor(call),
      intent: intentFor(call),
      outcome: outcomeFor(call),
      vapi_id: call.id,
      summary: call.analysis?.summary || call.summary || null,
      recording_url: call.recordingUrl || null,
      ended_reason: call.endedReason || null,
      cost: typeof call.cost === 'number' ? call.cost : null,
    };

    const existing = findByVapi.get(call.id) as { id: number } | undefined;
    if (existing) {
      update.run(row);
      result.updated++;
    } else {
      insert.run(row);
      result.inserted++;
      // extract a lead from genuinely new calls (fire-and-forget-ish; awaited for the count)
      const transcript = row.transcript;
      if (transcript) {
        try {
          const lead = await extractLead(transcript, row.from_number || undefined);
          if (lead.name || lead.need) {
            captureLead({ ...lead, source: 'vapi' });
            result.leads++;
          }
        } catch {
          /* graceful */
        }
      }
    }
  }
  return result;
}
