import { Router } from 'express';
import { getDb } from '../db/index';
import { syncSummary } from '../services/servicetradeSync';
import { bambooConfigured } from '../services/bamboo';
import { intacctConfigured, getIntacctMode } from '../services/sageIntacct';
import { entraConfigured } from '../people/identity';

/**
 * GET /api/sources — one reusable freshness model for every system of record, so no screen has to
 * hard-code "Intacct updated 8 min ago". Each source reports a status and, when known, when it last
 * synced. Honest states only: not_connected / stale / fresh / no_sync. The UI decides how to render;
 * the truth lives here.
 */
const router = Router();

type SourceStatus = 'fresh' | 'stale' | 'no_sync' | 'not_connected';

interface SourceHealth {
  key: string;
  label: string;
  connected: boolean;
  status: SourceStatus;
  lastSyncedAt: string | null; // ISO, when a real sync timestamp exists
  detail?: string;
}

const STALE_AFTER_MIN = 60; // older than this and we call a connected source "stale"

function classify(connected: boolean, lastSyncedAt: string | null): SourceStatus {
  if (!connected) return 'not_connected';
  if (!lastSyncedAt) return 'no_sync';
  const ageMin = (Date.now() - new Date(lastSyncedAt).getTime()) / 60000;
  return ageMin > STALE_AFTER_MIN ? 'stale' : 'fresh';
}

function newest(...iso: (string | null | undefined)[]): string | null {
  const times = iso.filter(Boolean).map((s) => new Date(s as string).getTime()).filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

router.get('/api/sources', (_req, res) => {
  const sources: SourceHealth[] = [];

  // ── ServiceTrade (operational truth) ──
  let st: ReturnType<typeof syncSummary> | null = null;
  try { st = syncSummary(); } catch { st = null; }
  const stConnected = !!st?.connected;
  const stNewest = st
    ? newest(st.entities.accounts.lastSynced, st.entities.sites.lastSynced, st.entities.jobs.lastSynced, st.entities.quotes.lastSynced, st.entities.invoices.lastSynced)
    : null;
  sources.push({
    key: 'servicetrade',
    label: 'ServiceTrade',
    connected: stConnected,
    status: classify(stConnected, stNewest),
    lastSyncedAt: stNewest,
    detail: st ? `${st.entities.accounts.count} accounts · ${st.entities.jobs.count} jobs · ${st.entities.quotes.count} quotes` : undefined,
  });

  // ── BambooHR (people truth) — last successful roster import from the audit trail ──
  const bambooConn = bambooConfigured();
  let bambooLast: string | null = null;
  try {
    const row = getDb().prepare(`SELECT MAX(at) AS at FROM people_audit WHERE action = 'bamboo_import'`).get() as { at: string | null } | undefined;
    bambooLast = row?.at ? new Date(row.at.replace(' ', 'T') + 'Z').toISOString() : null;
  } catch { bambooLast = null; }
  sources.push({
    key: 'bamboo',
    label: 'BambooHR',
    connected: bambooConn,
    status: classify(bambooConn, bambooLast),
    lastSyncedAt: bambooLast,
  });

  // ── Sage Intacct (financial truth) — connector is scaffolded; no mirror sync yet ──
  const intacctConn = intacctConfigured();
  sources.push({
    key: 'intacct',
    label: 'Sage Intacct',
    connected: intacctConn,
    status: intacctConn ? 'no_sync' : 'not_connected',
    lastSyncedAt: null,
    detail: intacctConn ? `connected (${getIntacctMode()}), financial sync not enabled yet` : 'financial reporting pending connection',
  });

  // ── Microsoft / Entra (identity) — configuration presence, not a data sync ──
  const entraConn = entraConfigured();
  sources.push({
    key: 'microsoft',
    label: 'Microsoft / Entra',
    connected: entraConn,
    status: entraConn ? 'fresh' : 'not_connected',
    lastSyncedAt: null,
    detail: entraConn ? 'identity sign-in configured' : 'sign-in not configured',
  });

  res.json({ ok: true, sources, checkedAt: new Date().toISOString() });
});

export default router;
