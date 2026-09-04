import { getDb } from '../db';
import { createApproval } from '../routes/approvals';
import { ensurePlatformSchema } from './schema';
import type { ApprovalLevel } from './contracts';

export interface WorkflowApprovalRequest {
  clientId?: string;
  workflowRunId: string;
  stepKey: string;
  actionKey: string;
  riskLevel: ApprovalLevel;
  agentKey: string;
  kind: string;
  risk: string;
  title: string;
  stake?: string;
  body?: string;
  trail?: string;
  subjectType?: string;
  subjectId?: number;
}

/**
 * Creates/refreshes the existing unified approval item and links it to a
 * durable workflow step. The `approvals` table remains the single human inbox.
 */
export function requestWorkflowApproval(input: WorkflowApprovalRequest): number {
  ensurePlatformSchema();
  const approvalId = createApproval({
    agent_key: input.agentKey,
    kind: input.kind,
    risk: input.risk,
    title: input.title,
    stake: input.stake,
    body: input.body,
    trail: input.trail,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
  });

  getDb().prepare(`
    INSERT INTO workflow_approval_links
      (approval_id, client_id, workflow_run_id, step_key, action_key, risk_level)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(approval_id) DO UPDATE SET
      client_id=excluded.client_id,
      workflow_run_id=excluded.workflow_run_id,
      step_key=excluded.step_key,
      action_key=excluded.action_key,
      risk_level=excluded.risk_level
  `).run(
    approvalId,
    input.clientId || '1stfp',
    input.workflowRunId,
    input.stepKey,
    input.actionKey,
    input.riskLevel,
  );
  return approvalId;
}

export function approvalDecision(approvalId: number): 'pending' | 'approved' | 'skipped' | string | undefined {
  const row = getDb().prepare(`SELECT status FROM approvals WHERE id = ?`).get(approvalId) as { status: string } | undefined;
  return row?.status;
}
