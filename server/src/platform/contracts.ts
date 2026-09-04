export type ApprovalLevel = 0 | 1 | 2 | 3 | 4;

export interface WorkflowDefinition {
  key: string;
  version: string;
  purpose: string;
  owner: string;
  trigger: string;
  successMetric: string;
}

export interface WorkflowContext {
  clientId: string;
  correlationId: string;
  workflowKey: string;
  workflowVersion: string;
  runId: string;
  actor?: string;
  officeKey?: string;
}

export interface ExternalResourceRef {
  system: string;
  resourceType: string;
  externalId: string;
  idempotencyKey: string;
  status: string;
}

export interface AgentPolicy {
  key: string;
  version: string;
  purpose: string;
  autonomousActionCeiling: ApprovalLevel;
  allowedTools: string[];
  successMetric: string;
}

export interface ModelRequest {
  task: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  quality?: 'fast' | 'balanced' | 'max';
  maxCostUsd?: number;
  preferredProvider?: string;
  preferredModel?: string;
  structuredOutput?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface ModelResponse {
  text: string;
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  raw?: unknown;
}
