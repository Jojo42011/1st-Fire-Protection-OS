import { toolRegistry, type ToolContext } from './toolRegistry';
import { requiresHumanApproval } from './approvalPolicy';
import { recordAgentAction, updateAgentAction } from './actionLedger';
import { recordAgentTrace } from './observability';
import type { ApprovalLevel } from './contracts';

export class ApprovalRequiredError extends Error {
  constructor(
    public readonly toolKey: string,
    public readonly riskLevel: ApprovalLevel,
  ) {
    super(`Human approval required for ${toolKey} (risk level ${riskLevel})`);
    this.name = 'ApprovalRequiredError';
  }
}

export interface ExecuteToolOptions<I> {
  toolKey: string;
  input: I;
  context: ToolContext;
  approved?: boolean;
  autonomousCeiling?: ApprovalLevel;
  approvalId?: number;
  agentKey?: string;
  agentVersion?: string;
  modelProvider?: string;
  modelName?: string;
}

/**
 * One controlled path for agent/tool execution. This is the boundary Relevance,
 * direct LLMs and future agent runtimes should call instead of invoking vendor
 * writes ad hoc.
 */
export async function executeTool<I = unknown, O = unknown>(options: ExecuteToolOptions<I>): Promise<O> {
  const tool = toolRegistry.get<I, O>(options.toolKey);
  if (!tool) throw new Error(`Unknown tool: ${options.toolKey}`);

  const ceiling = options.autonomousCeiling ?? 2;
  if (requiresHumanApproval(tool.riskLevel, ceiling) && !options.approved) {
    throw new ApprovalRequiredError(tool.key, tool.riskLevel);
  }

  const started = Date.now();
  const actionId = recordAgentAction({
    clientId: options.context.clientId,
    correlationId: options.context.correlationId,
    workflowRunId: options.context.workflowRunId,
    agentKey: options.agentKey,
    agentVersion: options.agentVersion,
    modelProvider: options.modelProvider,
    modelName: options.modelName,
    toolKey: tool.key,
    actionKey: tool.key,
    riskLevel: tool.riskLevel,
    approvalId: options.approvalId,
    status: 'running',
    detail: { mode: tool.mode, integration: tool.integration },
  });

  await recordAgentTrace({
    correlationId: options.context.correlationId,
    workflowRunId: options.context.workflowRunId,
    agentKey: options.agentKey,
    agentVersion: options.agentVersion,
    modelProvider: options.modelProvider,
    modelName: options.modelName,
    toolKey: tool.key,
    status: 'started',
  });

  try {
    const output = await tool.execute(options.input, options.context);
    updateAgentAction(actionId, 'completed');
    await recordAgentTrace({
      correlationId: options.context.correlationId,
      workflowRunId: options.context.workflowRunId,
      agentKey: options.agentKey,
      agentVersion: options.agentVersion,
      modelProvider: options.modelProvider,
      modelName: options.modelName,
      toolKey: tool.key,
      status: 'completed',
      latencyMs: Date.now() - started,
    });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateAgentAction(actionId, 'failed', { error: message });
    await recordAgentTrace({
      correlationId: options.context.correlationId,
      workflowRunId: options.context.workflowRunId,
      agentKey: options.agentKey,
      agentVersion: options.agentVersion,
      modelProvider: options.modelProvider,
      modelName: options.modelName,
      toolKey: tool.key,
      status: 'failed',
      latencyMs: Date.now() - started,
      metadata: { error: message },
    });
    throw error;
  }
}
