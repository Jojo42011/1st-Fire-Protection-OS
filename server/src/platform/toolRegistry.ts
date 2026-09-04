import type { ApprovalLevel } from './contracts';

export type ToolExecutionMode = 'native_api' | 'mcp' | 'connector' | 'browser_fallback';

export interface ToolContext {
  clientId: string;
  correlationId: string;
  workflowRunId?: string;
  actor?: string;
  officeKey?: string;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  key: string;
  description: string;
  integration: string;
  mode: ToolExecutionMode;
  riskLevel: ApprovalLevel;
  execute: (input: I, context: ToolContext) => Promise<O>;
}

class Registry {
  private readonly tools = new Map<string, ToolDefinition<any, any>>();

  register<I, O>(tool: ToolDefinition<I, O>): void {
    if (this.tools.has(tool.key)) throw new Error(`Tool already registered: ${tool.key}`);
    this.tools.set(tool.key, tool);
  }

  get<I = unknown, O = unknown>(key: string): ToolDefinition<I, O> | undefined {
    return this.tools.get(key) as ToolDefinition<I, O> | undefined;
  }

  list(): Array<Omit<ToolDefinition, 'execute'>> {
    return Array.from(this.tools.values()).map(({ execute: _execute, ...meta }) => meta);
  }
}

export const toolRegistry = new Registry();

/**
 * The preferred execution order is native API -> owned MCP/adapter -> trusted
 * connector -> browser fallback. Agent platforms call tools through this layer
 * rather than owning vendor credentials and side-effect semantics themselves.
 */
export function preferredExecutionMode(modes: ToolExecutionMode[]): ToolExecutionMode | undefined {
  const order: ToolExecutionMode[] = ['native_api', 'mcp', 'connector', 'browser_fallback'];
  return order.find((mode) => modes.includes(mode));
}
