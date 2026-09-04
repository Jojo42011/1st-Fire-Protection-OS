import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { ensurePlatformSchema } from './schema';
import type { WorkflowContext, WorkflowDefinition } from './contracts';

export function startWorkflow(def: WorkflowDefinition, input: unknown, opts?: { clientId?: string; actor?: string; officeKey?: string; correlationId?: string }): WorkflowContext {
  ensurePlatformSchema();
  const runId = randomUUID();
  const correlationId = opts?.correlationId || randomUUID();
  const ctx: WorkflowContext = {
    clientId: opts?.clientId || '1stfp',
    correlationId,
    workflowKey: def.key,
    workflowVersion: def.version,
    runId,
    actor: opts?.actor,
    officeKey: opts?.officeKey,
  };
  getDb().prepare(`
    INSERT INTO workflow_runs
      (id, client_id, workflow_key, workflow_version, correlation_id, actor, office_key, input_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, ctx.clientId, def.key, def.version, correlationId, ctx.actor || null, ctx.officeKey || null, JSON.stringify(input ?? null));
  return ctx;
}

export function beginStep(runId: string, stepKey: string, input?: unknown) {
  ensurePlatformSchema();
  getDb().prepare(`
    INSERT INTO workflow_steps (run_id, step_key, status, attempt, input_json, started_at)
    VALUES (?, ?, 'running', 1, ?, datetime('now'))
    ON CONFLICT(run_id, step_key) DO UPDATE SET
      status = CASE WHEN workflow_steps.status = 'completed' THEN 'completed' ELSE 'running' END,
      attempt = CASE WHEN workflow_steps.status = 'completed' THEN workflow_steps.attempt ELSE workflow_steps.attempt + 1 END,
      input_json = excluded.input_json,
      started_at = CASE WHEN workflow_steps.status = 'completed' THEN workflow_steps.started_at ELSE datetime('now') END
  `).run(runId, stepKey, JSON.stringify(input ?? null));
  return getDb().prepare(`SELECT * FROM workflow_steps WHERE run_id = ? AND step_key = ?`).get(runId, stepKey) as any;
}

export function completedStep<T = unknown>(runId: string, stepKey: string): T | undefined {
  ensurePlatformSchema();
  const row = getDb().prepare(`SELECT status, output_json FROM workflow_steps WHERE run_id = ? AND step_key = ?`).get(runId, stepKey) as any;
  if (!row || row.status !== 'completed') return undefined;
  return row.output_json == null ? (undefined as T | undefined) : JSON.parse(row.output_json) as T;
}

export function completeStep(runId: string, stepKey: string, output?: unknown): void {
  ensurePlatformSchema();
  getDb().prepare(`
    UPDATE workflow_steps SET status='completed', output_json=?, error=NULL, completed_at=datetime('now')
    WHERE run_id=? AND step_key=?
  `).run(JSON.stringify(output ?? null), runId, stepKey);
}

export function failStep(runId: string, stepKey: string, error: unknown): void {
  ensurePlatformSchema();
  getDb().prepare(`
    UPDATE workflow_steps SET status='failed', error=?, completed_at=datetime('now')
    WHERE run_id=? AND step_key=?
  `).run(error instanceof Error ? error.message : String(error), runId, stepKey);
}

export function finishWorkflow(runId: string, output?: unknown): void {
  ensurePlatformSchema();
  getDb().prepare(`UPDATE workflow_runs SET status='completed', output_json=?, completed_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(output ?? null), runId);
}

export function failWorkflow(runId: string, error: unknown): void {
  ensurePlatformSchema();
  getDb().prepare(`UPDATE workflow_runs SET status='failed', error=?, completed_at=datetime('now') WHERE id=?`)
    .run(error instanceof Error ? error.message : String(error), runId);
}
