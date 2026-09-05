import fs from 'fs';
import { getDb } from '../db/index';
import { getState } from '../db/schema';
import { authRequired } from '../auth';
import { osAuthMode } from '../os/authz';
import { entraConfigured } from '../people/identity';
import { resolveIntegrations, integrationConnected } from '../config/integrations';
import { listSchedules } from '../services/syncScheduler';
import { failedActionCount } from '../services/outbox';

/**
 * Production readiness: a SAFE, non-secret snapshot of the posture that matters in live operation.
 * Never returns secret values, token digests, PII, raw webhooks, or the database path. Freshness and
 * backup verification use an honest model: "not configured" / "unknown" rather than false assurance.
 */

const liveMode = (): boolean => process.env.DEMO_MODE === 'off';
const has = (...keys: string[]): boolean => keys.every((k) => !!process.env[k]);

/** Off-Fly encrypted backup export is opt-in via env; disabled by default. */
export function offFlyBackupConfigured(): boolean {
  return has('BACKUP_UPLOAD_URL', 'BACKUP_ENCRYPTION_KEY');
}

function dbHealth(): { integrity: string; size_bytes: number | null } {
  let integrity = 'unknown';
  let size: number | null = null;
  try {
    const r = getDb().prepare('PRAGMA quick_check').get() as any;
    integrity = r && (r.quick_check === 'ok' || Object.values(r)[0] === 'ok') ? 'ok' : 'issues';
  } catch { integrity = 'unknown'; }
  try { const p = process.env.DB_PATH; if (p && fs.existsSync(p)) size = fs.statSync(p).size; } catch { size = null; }
  return { integrity, size_bytes: size };
}

function count(sql: string): number {
  try { return (getDb().prepare(sql).get() as { c: number }).c; } catch { return 0; }
}

export interface Readiness {
  generated_at: string;
  posture: {
    demo_mode: boolean; live_mode: boolean; os_auth_mode: string;
    identity_enforced: boolean; shared_password_active: boolean; entra_configured: boolean;
  };
  admin: { admin_secret_configured: boolean; fails_closed_in_prod: boolean };
  webhooks: { vapi_secret_configured: boolean; servicetrade_secret_configured: boolean };
  integrations: Array<{ id: string; name: string; status: string }>;
  sync: Array<{ key: string; label: string; last_run_at: string | null; last_status: string | null; fresh: boolean; detail: string | null }>;
  backups: { last_backup_at: string | null; off_fly_configured: boolean; off_fly_verified: string };
  approvals: { pending: number };
  external_actions: { pending: number; failed: number };
  database: { integrity: string; size_bytes: number | null; migrations: string };
  warnings: string[];
}

export function readinessReport(): Readiness {
  const mode = osAuthMode();
  const sharedPw = authRequired();
  const entra = entraConfigured();
  const adminSecret = !!process.env.ADMIN_TOKEN;
  const vapiSecret = !!process.env.VAPI_SERVER_SECRET;
  const stSecret = !!process.env.SERVICETRADE_WEBHOOK_SECRET;

  const schedules = (() => { try { return listSchedules(); } catch { return []; } })();
  const now = Date.now();
  const sync = schedules.map((s: any) => {
    const last = s.last_run_at ? Date.parse(s.last_run_at) : NaN;
    const interval = (Number(s.interval_minutes) || 60) * 60_000;
    const fresh = Number.isFinite(last) && (now - last) <= interval * 3 && s.last_status === 'ok';
    return { key: s.integration_key, label: s.label, last_run_at: s.last_run_at ?? null, last_status: s.last_status ?? null, fresh, detail: s.last_detail ?? null };
  });

  const warnings: string[] = [];
  if (liveMode()) {
    if (mode === 'legacy') warnings.push('OS_AUTH_MODE=legacy: identity is NOT enforced; sensitive actions rely only on the shared password. Move to hybrid.');
    if (sharedPw && mode === 'hybrid') warnings.push('Hybrid mode: reads are open to the shared password. Plan the move to enforce once every operator is mapped to an Entra identity.');
    if (!entra) warnings.push('Entra sign-in is not configured (ENTRA_*): no mapped identities are possible, so hybrid/enforce cannot authorize anyone.');
    if (!adminSecret) warnings.push('ADMIN_TOKEN is not set: admin backup/reset endpoints fail closed (no database export is possible until it is set).');
    if (!vapiSecret && integrationConnected('vapi')) warnings.push('VAPI_SERVER_SECRET is not set while Vapi is connected: live call webhooks are rejected.');
    if (!stSecret && integrationConnected('servicetrade')) warnings.push('SERVICETRADE_WEBHOOK_SECRET is not set while ServiceTrade is connected: live webhooks are rejected.');
    if (!offFlyBackupConfigured()) warnings.push('Off-Fly backup export is not configured: recovery relies on Fly volume snapshots with limited (~5 day) retention.');
    for (const s of sync) if (integrationConnected(s.key) && !s.fresh) warnings.push(`Sync source "${s.label}" is stale or failing (last status: ${s.last_status || 'never'}).`);
    const failed = failedActionCount();
    if (failed > 0) warnings.push(`${failed} external action(s) have failed and need review.`);
  }

  return {
    generated_at: new Date().toISOString(),
    posture: {
      demo_mode: !liveMode(), live_mode: liveMode(), os_auth_mode: mode,
      identity_enforced: mode === 'enforce', shared_password_active: sharedPw, entra_configured: entra,
    },
    admin: { admin_secret_configured: adminSecret, fails_closed_in_prod: !adminSecret },
    webhooks: { vapi_secret_configured: vapiSecret, servicetrade_secret_configured: stSecret },
    integrations: resolveIntegrations().map((i: any) => ({ id: i.id, name: i.name, status: i.status })),
    sync,
    backups: {
      last_backup_at: getState('last_backup_at'),
      off_fly_configured: offFlyBackupConfigured(),
      off_fly_verified: offFlyBackupConfigured() ? (getState('last_offfly_backup_at') ? 'configured' : 'unknown') : 'not_configured',
    },
    approvals: { pending: count(`SELECT COUNT(*) c FROM approvals WHERE status = 'pending'`) },
    external_actions: {
      pending: count(`SELECT COUNT(*) c FROM external_actions WHERE status IN ('pending_approval','approved','sending')`),
      failed: failedActionCount(),
    },
    database: { ...dbHealth(), migrations: 'idempotent (initDb on boot)' },
    warnings,
  };
}

/** Log high-severity readiness warnings once at boot (live mode only). */
export function bootReadinessWarnings(): void {
  if (!liveMode()) return;
  try {
    const r = readinessReport();
    if (r.warnings.length) {
      console.warn(`[readiness] ${r.warnings.length} production warning(s):`);
      for (const w of r.warnings) console.warn('  ! ' + w);
    }
  } catch (e) { console.warn('[readiness] boot check error:', (e as Error).message); }
}
