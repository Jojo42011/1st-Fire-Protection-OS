import { getDb } from '../db';
import { ensurePlatformSchema } from './schema';
import type { ApprovalLevel } from './contracts';

export interface AgentActionRecord {
  clientId?: string;
  correlationId: string;
  workflowRunId?: string;
  stepKey?: string;
  agentKey?: string;
  agentVersion?: string;
  modelProvider?: string;
  modelName?: string;
  toolKey?: string;
  actionKey: string;
  riskLevel?: ApprovalLevel;
  approvalId?: number;
  externalResourceId?: number;
  status: 'planned' | 'running' | 'completed' | 'failed' | 'skipped';
  detail?: unknown;
}

export function recordAgentAction(action: AgentActionRecord): number {
  ensurePlatformSchema();
  const result = getDb().prepare(`
    INSERT INTO agent_actions
      (client_id, correlation_id, workflow_run_id, step_key, agent_key, agent_version,
       model_provider, model_name, tool_key, action_key, risk_level, approval_id,
       external_resource_id, status, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    action.clientId || '1stfp',
    action.correlationId,
    action.workflowRunId || null,
    action.stepKey || null,
    action.agentKey || null,
    action.agentVersion || null,
    action.modelProvider || null,
    action.modelName || null,
    action.toolKey || null,
    action.actionKey,
    action.riskLevel ?? 0,
    action.approvalId ?? null,
    action.externalResourceId ?? null,
    action.status,
    action.detail === undefined ? null : JSON.stringify(action.detail),
  );
  return Number(result.lastInsertRowid);
}

export function updateAgentAction(id: number, status: AgentActionRecord['status'], detail?: unknown): void {
  ensurePlatformSchema();
  getDb().prepare(`UPDATE agent_actions SET status = ?, detail_json = COALESCE(?, detail_json) WHERE id = ?`)
    .run(status, detail === undefined ? null : JSON.stringify(detail), id);
}
