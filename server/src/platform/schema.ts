import { getDb } from '../db';

/**
 * Platform tables are additive to the existing domain schema. Existing 1st FP
 * tables such as `approvals` remain authoritative; the platform layer links to
 * them rather than creating a competing inbox.
 */
export function ensurePlatformSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL DEFAULT '1stfp',
      workflow_key TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      actor TEXT,
      office_key TEXT,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_corr ON workflow_runs(correlation_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 0,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(run_id, step_key),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS external_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL DEFAULT '1stfp',
      system TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      workflow_run_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, system, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_external_resource_lookup
      ON external_resources(client_id, system, resource_type, external_id);

    /* The existing `approvals` table stays the single inbox. This table adds
       workflow correlation without duplicating approval state. */
    CREATE TABLE IF NOT EXISTS workflow_approval_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id INTEGER NOT NULL UNIQUE,
      client_id TEXT NOT NULL DEFAULT '1stfp',
      workflow_run_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      action_key TEXT NOT NULL,
      risk_level INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_approval_run ON workflow_approval_links(workflow_run_id, step_key);

    CREATE TABLE IF NOT EXISTS agent_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL DEFAULT '1stfp',
      correlation_id TEXT NOT NULL,
      workflow_run_id TEXT,
      step_key TEXT,
      agent_key TEXT,
      agent_version TEXT,
      model_provider TEXT,
      model_name TEXT,
      tool_key TEXT,
      action_key TEXT NOT NULL,
      risk_level INTEGER NOT NULL DEFAULT 0,
      approval_id INTEGER,
      external_resource_id INTEGER,
      status TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_actions_corr ON agent_actions(correlation_id);

    CREATE TABLE IF NOT EXISTS platform_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      client_id TEXT NOT NULL DEFAULT '1stfp',
      source TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      schema_version TEXT NOT NULL DEFAULT '1',
      actor_json TEXT,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'received',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      processed_at TEXT,
      error TEXT,
      occurred_at TEXT DEFAULT (datetime('now')),
      received_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_platform_events_pending ON platform_events(status, next_attempt_at, received_at);

    CREATE TABLE IF NOT EXISTS agent_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_key TEXT NOT NULL,
      version TEXT NOT NULL,
      model_policy_json TEXT,
      tool_policy_json TEXT,
      approval_ceiling INTEGER NOT NULL DEFAULT 2,
      eval_dataset TEXT,
      success_metric TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(agent_key, version)
    );

    CREATE TABLE IF NOT EXISTS measured_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL DEFAULT '1stfp',
      initiative_key TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      baseline REAL,
      target REAL,
      actual REAL,
      economic_value REAL,
      confidence REAL,
      period_start TEXT,
      period_end TEXT,
      evidence_json TEXT,
      verified_by TEXT,
      verified_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}
