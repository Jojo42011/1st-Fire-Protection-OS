import { getDb } from '../db';
import { ensurePlatformSchema } from './schema';
import { InngestEventPublisher } from './inngest';

interface EventRow {
  event_id: string;
  event_type: string;
  client_id: string;
  source: string;
  correlation_id: string;
  schema_version: string;
  actor_json: string | null;
  payload_json: string | null;
  attempts: number;
}

const publisher = new InngestEventPublisher();
let timer: NodeJS.Timeout | null = null;
let running = false;

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

function backoffSeconds(attempt: number): number {
  return Math.min(900, Math.max(5, 5 * Math.pow(2, Math.min(attempt, 7))));
}

/**
 * Hands canonical OS events to Inngest using the same event ID, so duplicate
 * delivery is safe. If Inngest is unavailable the event remains in the local
 * ledger and is retried later.
 */
export async function dispatchPendingEvents(limit = 25): Promise<{ dispatched: number; failed: number }> {
  ensurePlatformSchema();
  if (!publisher.isConfigured() || running) return { dispatched: 0, failed: 0 };
  running = true;
  let dispatched = 0;
  let failed = 0;

  try {
    const rows = getDb().prepare(`
      SELECT event_id, event_type, client_id, source, correlation_id, schema_version,
             actor_json, payload_json, attempts
      FROM platform_events
      WHERE status IN ('received', 'retry')
        AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
      ORDER BY received_at ASC
      LIMIT ?
    `).all(limit) as EventRow[];

    for (const row of rows) {
      try {
        await publisher.send({
          id: row.event_id,
          name: `systemize/${row.event_type}`,
          data: {
            event_id: row.event_id,
            event_type: row.event_type,
            client_id: row.client_id,
            source: row.source,
            correlation_id: row.correlation_id,
            schema_version: row.schema_version,
            actor: parseJson(row.actor_json),
            payload: parseJson(row.payload_json),
          },
        });
        getDb().prepare(`
          UPDATE platform_events
          SET status='dispatched', attempts=attempts+1, processed_at=datetime('now'),
              next_attempt_at=NULL, error=NULL
          WHERE event_id=?
        `).run(row.event_id);
        dispatched += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const seconds = backoffSeconds(attempts);
        getDb().prepare(`
          UPDATE platform_events
          SET status='retry', attempts=?, error=?,
              next_attempt_at=datetime('now', '+' || ? || ' seconds')
          WHERE event_id=?
        `).run(attempts, error instanceof Error ? error.message : String(error), seconds, row.event_id);
        failed += 1;
      }
    }
  } finally {
    running = false;
  }

  return { dispatched, failed };
}

/** Start one lightweight retry loop per process. Inngest still owns durable job execution. */
export function startEventDispatcher(intervalMs = 30_000): void {
  if (timer || !publisher.isConfigured()) return;
  void dispatchPendingEvents();
  timer = setInterval(() => { void dispatchPendingEvents(); }, intervalMs);
  timer.unref?.();
}
