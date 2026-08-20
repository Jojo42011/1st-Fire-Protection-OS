/**
 * Configurable per-integration sync scheduler.
 *
 * Each syncing integration (ServiceTrade, BambooHR, Microsoft 365 / vendor seats, and the phone
 * receptionist) has a cadence the operator can set: how often it auto-syncs, or paused. A single
 * master tick (runDueSyncs, called once a minute from app.ts) runs each enabled integration when it
 * is due (now - last_run >= its interval). "Sync now" forces one immediately. All sync functions are
 * keyless-safe and never throw, so a missing credential is a graceful no-op, not a crash.
 */
import { getDb } from '../db/index';
import { runScheduledSync } from './servicetradeSync';
import { syncSchedule } from './scheduleSync';
import { syncPlans } from './planSync';
import { syncFromVapi } from './receptionist';
import { importFromBamboo } from '../people/service';
import { fetchAllVendorSeats } from './licenseSources';
import { detectExceptions } from '../os/exceptions';

export interface SyncDef {
  key: string;
  label: string;
  detail: string; // what it pulls, for the UI
  defaultInterval: number; // minutes
  run: () => Promise<string>; // returns a short result detail; must not throw
}

/** Microsoft 365 / software-vendor seats: refresh each keyed vendor's API seats (replace-by-vendor,
 *  preserving manually imported CSV rows). Mirrors the /api/licenses/sync seat pass. */
async function syncVendorSeats(): Promise<string> {
  const seats = await fetchAllVendorSeats();
  if (!seats.length) return 'no vendor seats (no keys configured)';
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO license_seats (vendor, product, assignee_email, assignee_name, cost_monthly, assigned_at, source)
     VALUES (@vendor, @product, @assignee_email, @assignee_name, @cost_monthly, @assigned_at, @source)`
  );
  const del = db.prepare(`DELETE FROM license_seats WHERE vendor = ? AND source != 'manual'`);
  const byVendor = new Set(seats.map((s) => s.vendor));
  const tx = db.transaction(() => {
    for (const v of byVendor) del.run(v);
    for (const s of seats) ins.run(s);
  });
  tx();
  return `${seats.length} seat(s) across ${byVendor.size} vendor(s)`;
}

/** The registry: every integration the scheduler drives, its default cadence, and its sync call. */
export const SYNC_DEFS: SyncDef[] = [
  {
    key: 'servicetrade',
    label: 'ServiceTrade',
    detail: 'Accounts, sites, jobs, quotes, invoices, deficiencies',
    defaultInterval: 15,
    run: async () => {
      const st: any = await runScheduledSync();
      await syncSchedule();
      await syncPlans();
      // Refresh the exceptions queue off the freshly-synced mirror (idempotent, self-healing).
      try { detectExceptions(); } catch { /* detection is best-effort */ }
      const n = st && (st.accounts || st.sites || st.invoices) ? 'records updated' : 'no changes';
      return `ServiceTrade cycle: ${n}`;
    },
  },
  {
    key: 'bamboo',
    label: 'BambooHR',
    detail: 'Employee roster and terminations',
    defaultInterval: 60,
    run: async () => {
      const r: any = await importFromBamboo('scheduler');
      if (!r || r.ok === false) return `not synced (${(r && r.reason) || 'unavailable'})`;
      return `roster imported${r.imported != null ? `: ${r.imported}` : ''}`;
    },
  },
  {
    key: 'microsoft',
    label: 'Microsoft 365 / vendor seats',
    detail: 'License seats from M365 and the software vendors',
    defaultInterval: 720,
    run: syncVendorSeats,
  },
  {
    key: 'calls',
    label: 'Phone receptionist',
    detail: 'Inbound calls and captured leads',
    defaultInterval: 5,
    run: async () => {
      const r: any = await syncFromVapi();
      if (r && r.error) return `error: ${r.error}`;
      return r && r.synced ? `${r.synced} call(s) synced` : 'no new calls';
    },
  },
];

const DEF_BY_KEY = new Map(SYNC_DEFS.map((d) => [d.key, d]));

export interface ScheduleRow {
  integration_key: string;
  label: string;
  detail: string;
  interval_minutes: number;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string;
  last_detail: string | null;
  next_run_at: string | null;
}

/** The stored cadence for one integration, falling back to its coded default when no row exists. */
function rowFor(def: SyncDef): ScheduleRow {
  const stored = getDb()
    .prepare(`SELECT interval_minutes, enabled, last_run_at, last_status, last_detail FROM sync_schedules WHERE integration_key = ?`)
    .get(def.key) as
    | { interval_minutes: number; enabled: number; last_run_at: string | null; last_status: string | null; last_detail: string | null }
    | undefined;
  const interval = stored ? stored.interval_minutes : def.defaultInterval;
  const enabled = stored ? stored.enabled === 1 : true;
  const lastRun = stored?.last_run_at ?? null;
  const nextRun = enabled && interval > 0 && lastRun ? new Date(new Date(lastRun).getTime() + interval * 60000).toISOString() : enabled && interval > 0 ? 'due' : null;
  return {
    integration_key: def.key,
    label: def.label,
    detail: def.detail,
    interval_minutes: interval,
    enabled,
    last_run_at: lastRun,
    last_status: stored?.last_status ?? 'never',
    last_detail: stored?.last_detail ?? null,
    next_run_at: nextRun,
  };
}

/** Every integration's current schedule (for the settings UI). */
export function listSchedules(): ScheduleRow[] {
  return SYNC_DEFS.map(rowFor);
}

/** Set the cadence for one integration. interval_minutes 0 (or enabled=false) pauses it. */
export function setSchedule(key: string, patch: { interval_minutes?: number; enabled?: boolean }): ScheduleRow | null {
  const def = DEF_BY_KEY.get(key);
  if (!def) return null;
  const cur = rowFor(def);
  const interval = patch.interval_minutes != null ? Math.max(0, Math.round(patch.interval_minutes)) : cur.interval_minutes;
  const enabled = patch.enabled != null ? patch.enabled : cur.enabled;
  getDb()
    .prepare(
      `INSERT INTO sync_schedules (integration_key, interval_minutes, enabled, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(integration_key) DO UPDATE SET interval_minutes = excluded.interval_minutes, enabled = excluded.enabled, updated_at = datetime('now')`
    )
    .run(key, interval, enabled ? 1 : 0);
  return rowFor(def);
}

function recordRun(key: string, status: 'ok' | 'error', detail: string): void {
  getDb()
    .prepare(
      `INSERT INTO sync_schedules (integration_key, interval_minutes, enabled, last_run_at, last_status, last_detail, updated_at)
       VALUES (?, ?, 1, datetime('now'), ?, ?, datetime('now'))
       ON CONFLICT(integration_key) DO UPDATE SET last_run_at = datetime('now'), last_status = excluded.last_status, last_detail = excluded.last_detail`
    )
    .run(key, DEF_BY_KEY.get(key)?.defaultInterval ?? 60, status, detail.slice(0, 400));
}

/** Force-run one integration now, regardless of cadence. */
export async function runSyncNow(key: string): Promise<{ ok: boolean; status: string; detail: string } | null> {
  const def = DEF_BY_KEY.get(key);
  if (!def) return null;
  try {
    const detail = await def.run();
    recordRun(key, 'ok', detail);
    return { ok: true, status: 'ok', detail };
  } catch (e) {
    const detail = (e as Error).message || 'sync failed';
    recordRun(key, 'error', detail);
    return { ok: false, status: 'error', detail };
  }
}

/** Whether an integration is due to run now, given its stored cadence. */
function isDue(row: ScheduleRow): boolean {
  if (!row.enabled || row.interval_minutes <= 0) return false;
  if (!row.last_run_at) return true;
  return Date.now() - new Date(row.last_run_at).getTime() >= row.interval_minutes * 60000;
}

/** The master tick: run every integration that is due. Called once a minute from app.ts. */
export async function runDueSyncs(): Promise<void> {
  for (const def of SYNC_DEFS) {
    const row = rowFor(def);
    if (isDue(row)) {
      // eslint-disable-next-line no-await-in-loop
      await runSyncNow(def.key);
    }
  }
}
