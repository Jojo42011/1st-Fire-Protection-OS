import fs from 'fs';
import path from 'path';
import { getDb } from '../db/index';
import { getState } from '../db/schema';
import { COMPANY } from '../config/constants';
import { AGENTS } from '../config/agents';
import { resolveIntegrations, integrationConnected } from '../config/integrations';
import { activeProvider, embeddingsEnabled } from '../config/models';
import { telephonyEnabled, ttsEnabled } from '../config/voice';

/**
 * Introspection snapshot for Booker Growth OS — CAPABILITY AND USAGE METADATA ONLY.
 *
 * Hard boundary, by construction: every query in this file is a COUNT(*), MAX(timestamp)
 * or config lookup. No SELECT here may return customer names, phone numbers, emails,
 * message bodies, transcripts, or per-invoice amounts. If a field could identify a real
 * customer, it does not belong in this payload.
 */

export interface CapabilityEntry {
  key: string;
  name: string;
  kind: 'AGENT' | 'AUTOMATION' | 'INTEGRATION' | 'MODULE';
  enabled: boolean;
  runs30d: number;
  failures30d: number;
  lastUsedAt: string | null;
  notes: string;
}

export interface IntrospectionSnapshot {
  app: {
    name: string;
    coreVersion: string;
    plugins: { id: string; version: string }[];
  };
  health: {
    status: string;
    queueDepth: number;
    failedJobs: number;
    lastBackupAt: string | null;
  };
  capabilities: CapabilityEntry[];
  manualHotspots: string[];
  counts: Record<string, number>;
  notes: string;
}

/** COUNT(*) helper — the only row shape this module ever reads. */
function count(sql: string): number {
  const row = getDb().prepare(sql).get() as { v: number } | undefined;
  return row ? Number(row.v) || 0 : 0;
}

/** MAX(timestamp) helper — normalized to ISO or null. */
function latest(sql: string): string | null {
  const row = getDb().prepare(sql).get() as { v: string | null } | undefined;
  if (!row || !row.v) return null;
  const d = new Date(row.v.includes('T') ? row.v : row.v.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? row.v : d.toISOString();
}

function coreVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')
    ) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The last 30 days, tolerant of both ISO (T/Z) and SQLite (space) timestamp formats. */
const IN_30D = (col: string) => `datetime(${col}) >= datetime('now','-30 days')`;

export function buildIntrospectionSnapshot(): IntrospectionSnapshot {
  const version = coreVersion();
  const provider = activeProvider();

  // ---- capabilities: agents ----
  const capabilities: CapabilityEntry[] = [];

  capabilities.push({
    key: 'call-receptionist',
    name: 'Call Receptionist',
    kind: 'AGENT',
    enabled: telephonyEnabled(),
    runs30d: count(`SELECT COUNT(*) AS v FROM calls WHERE ${IN_30D('started_at')}`),
    failures30d: count(
      `SELECT COUNT(*) AS v FROM calls WHERE outcome = 'missed' AND ${IN_30D('started_at')}`
    ),
    lastUsedAt: latest(`SELECT MAX(started_at) AS v FROM calls`),
    notes: telephonyEnabled()
      ? 'Answers the Riverton line via Vapi/Twilio; failures30d = missed calls.'
      : 'Wired but no telephony provider connected: calls in the log are seeded/manual entries.',
  });

  capabilities.push({
    key: 'vapi-call-tracking',
    name: 'Vapi call sync (webhook + 5-min backfill)',
    kind: 'INTEGRATION',
    enabled: !!process.env.VAPI_API_KEY,
    runs30d: count(
      `SELECT COUNT(*) AS v FROM calls WHERE vapi_call_id IS NOT NULL AND ${IN_30D('started_at')}`
    ),
    failures30d: 0,
    lastUsedAt: latest(
      `SELECT MAX(started_at) AS v FROM calls WHERE vapi_call_id IS NOT NULL`
    ),
    notes: 'Real-time end-of-call webhook plus periodic backfill; runs30d = provider calls ingested.',
  });

  capabilities.push({
    key: 'invoice-collector',
    name: 'Invoice Collector (reminder drafting)',
    kind: 'AGENT',
    enabled: true,
    runs30d: count(`SELECT COUNT(*) AS v FROM invoice_reminders WHERE ${IN_30D('created_at')}`),
    failures30d: 0,
    lastUsedAt: latest(`SELECT MAX(created_at) AS v FROM invoice_reminders`),
    notes: 'Drafts tiered (friendly/firm/final) reminders; a human approves before anything sends.',
  });

  const dunningSent = count(
    `SELECT COUNT(*) AS v FROM invoice_workflow_log WHERE status = 'sent' AND ${IN_30D('created_at')}`
  );
  const dunningSimulated = count(
    `SELECT COUNT(*) AS v FROM invoice_workflow_log WHERE status = 'simulated' AND ${IN_30D('created_at')}`
  );
  capabilities.push({
    key: 'collection-workflow',
    name: 'Daily dunning workflow (email + SMS until paid)',
    kind: 'AUTOMATION',
    enabled: true,
    runs30d: count(`SELECT COUNT(*) AS v FROM invoice_workflow_log WHERE ${IN_30D('created_at')}`),
    failures30d: count(
      `SELECT COUNT(*) AS v FROM invoice_workflow_log WHERE status = 'failed' AND ${IN_30D('created_at')}`
    ),
    lastUsedAt: latest(`SELECT MAX(created_at) AS v FROM invoice_workflow_log`),
    notes: `${dunningSent} touches actually sent, ${dunningSimulated} simulated (drafted+logged only) in last 30d (simulated means the email/SMS integration is not connected).`,
  });

  capabilities.push({
    key: 'review-collector',
    name: 'Review Collector (post-job review requests)',
    kind: 'AGENT',
    enabled: true,
    runs30d: count(`SELECT COUNT(*) AS v FROM review_requests WHERE ${IN_30D('created_at')}`),
    failures30d: 0,
    lastUsedAt: latest(`SELECT MAX(created_at) AS v FROM review_requests`),
    notes: `Requests are drafted for approval; ${count(
      `SELECT COUNT(*) AS v FROM review_requests WHERE status = 'sent'`
    )} marked sent all-time.`,
  });

  capabilities.push({
    key: 'review-reply-drafting',
    name: 'Review reply drafting',
    kind: 'AGENT',
    enabled: true,
    runs30d: count(
      `SELECT COUNT(*) AS v FROM reviews WHERE reply_status != 'none' AND ${IN_30D('received_at')}`
    ),
    failures30d: 0,
    lastUsedAt: latest(`SELECT MAX(received_at) AS v FROM reviews WHERE reply_status != 'none'`),
    notes: 'Drafts on-brand replies to incoming reviews; publishing is a manual, human-gated step.',
  });

  capabilities.push({
    key: 'brain-chat',
    name: 'Operator brain chat (shared intelligence + open_tab control)',
    kind: 'AGENT',
    enabled: true,
    runs30d: count(
      `SELECT COUNT(*) AS v FROM conversations WHERE role = 'user' AND ${IN_30D('created_at')}`
    ),
    failures30d: 0,
    lastUsedAt: latest(`SELECT MAX(created_at) AS v FROM conversations`),
    notes: provider === 'none' ? 'Running in reasoned-template mode (no LLM key configured).' : '',
  });

  capabilities.push({
    key: 'memory-graph',
    name: 'Memory graph (facts / episodes / rules)',
    kind: 'MODULE',
    enabled: true,
    runs30d: count(`SELECT COUNT(*) AS v FROM episodes WHERE ${IN_30D('created_at')}`),
    failures30d: 0,
    lastUsedAt: latest(`SELECT MAX(created_at) AS v FROM episodes`),
    notes: `${count('SELECT COUNT(*) AS v FROM facts')} facts, ${count(
      'SELECT COUNT(*) AS v FROM episodes'
    )} episodes stored; embeddings ${embeddingsEnabled() ? 'enabled' : 'disabled (no OpenAI key)'}.`,
  });

  capabilities.push({
    key: 'reflection',
    name: 'Periodic self-reflection (30-min synthesis of recent activity)',
    kind: 'AUTOMATION',
    enabled: provider !== 'none',
    runs30d: count(`SELECT COUNT(*) AS v FROM syntheses WHERE ${IN_30D('created_at')}`),
    failures30d: 0,
    lastUsedAt: latest(`SELECT MAX(created_at) AS v FROM syntheses`),
    notes: provider === 'none' ? 'No-ops without an LLM key.' : '',
  });

  capabilities.push({
    key: 'voice-pipeline',
    name: 'Voice pipeline (ElevenLabs TTS/STT)',
    kind: 'MODULE',
    enabled: ttsEnabled(),
    runs30d: 0,
    failures30d: 0,
    lastUsedAt: null,
    notes: ttsEnabled()
      ? 'TTS/STT live.'
      : 'Wired with graceful degradation to browser speech; no ELEVENLABS_API_KEY set. Usage not metered.',
  });

  // ---- capabilities: the integration catalog, with live connection status ----
  for (const integ of resolveIntegrations()) {
    capabilities.push({
      key: `integration:${integ.id}`,
      name: integ.name,
      kind: 'INTEGRATION',
      enabled: integ.status === 'connected',
      runs30d: 0,
      failures30d: 0,
      lastUsedAt: null,
      notes: `${integ.status}: ${integ.why} (per-integration usage is not metered)`,
    });
  }

  // ---- health ----
  const queueDepth = count(
    `SELECT COUNT(*) AS v FROM invoice_workflow
      WHERE status = 'active' AND (next_run_at IS NULL OR next_run_at <= datetime('now'))`
  );
  const failedJobs = count(
    `SELECT COUNT(*) AS v FROM invoice_workflow_log WHERE status = 'failed' AND ${IN_30D('created_at')}`
  );

  // ---- manual hotspots, derived from what is actually (not) connected ----
  const manualHotspots: string[] = [];
  if (!integrationConnected('servicetrade')) {
    manualHotspots.push(
      'Invoices and completed jobs are keyed in by hand: ServiceTrade (the field-service system of record) is not synced, so records are re-entered manually.'
    );
  }
  if (!integrationConnected('gmail') && !integrationConnected('sms')) {
    manualHotspots.push(
      'Dunning emails and texts are drafted and logged but only SIMULATED: a human must deliver every reminder manually until an email/SMS integration is connected.'
    );
  }
  if (!integrationConnected('google_business') && !integrationConnected('facebook')) {
    manualHotspots.push(
      'Incoming reviews are copy-pasted into the system by hand, and approved review replies must be posted to Google/Facebook manually.'
    );
  }
  if (!telephonyEnabled()) {
    manualHotspots.push('No telephony provider connected: call records are entered manually.');
  }
  manualHotspots.push(
    'All outbound sends (invoice reminders, review requests, review replies) are human-approved drafts; approval happens in the dashboard, delivery depends on integrations.'
  );
  if (!getState('last_backup_at')) {
    manualHotspots.push(
      'Database backups are manual: an operator must download /api/admin/backup; no scheduled backup exists.'
    );
  }

  // ---- aggregate counts ONLY (never rows) ----
  const counts: Record<string, number> = {
    contacts: count('SELECT COUNT(*) AS v FROM leads'),
    invoices: count('SELECT COUNT(*) AS v FROM invoices'),
    invoicesUnpaid: count(`SELECT COUNT(*) AS v FROM invoices WHERE status != 'paid'`),
    calls30d: count(`SELECT COUNT(*) AS v FROM calls WHERE ${IN_30D('started_at')}`),
    jobs30d: count(`SELECT COUNT(*) AS v FROM jobs WHERE ${IN_30D('completed_at')}`),
    reviews: count('SELECT COUNT(*) AS v FROM reviews'),
    activeDunningWorkflows: count(
      `SELECT COUNT(*) AS v FROM invoice_workflow WHERE status = 'active'`
    ),
  };

  return {
    app: {
      name: `${COMPANY.name} OS`,
      coreVersion: version,
      plugins: AGENTS.map((a) => ({ id: a.key, version })),
    },
    health: {
      status: provider === 'none' ? 'degraded' : 'ok',
      queueDepth,
      failedJobs,
      lastBackupAt: getState('last_backup_at'),
    },
    capabilities,
    manualHotspots,
    counts,
    notes:
      provider === 'none'
        ? 'LLM provider not configured: drafting agents run in reasoned-template mode.'
        : `LLM provider: ${provider}.`,
  };
}
