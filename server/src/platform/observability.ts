export interface AgentTrace {
  correlationId: string;
  workflowRunId?: string;
  stepKey?: string;
  agentKey?: string;
  agentVersion?: string;
  promptVersion?: string;
  modelProvider?: string;
  modelName?: string;
  toolKey?: string;
  status: 'started' | 'completed' | 'failed';
  latencyMs?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface ObservabilitySink {
  record(trace: AgentTrace): Promise<void> | void;
}

class ConsoleSink implements ObservabilitySink {
  record(trace: AgentTrace): void {
    if (process.env.AGENT_TRACE_CONSOLE === '1') console.log('[agent-trace]', JSON.stringify(trace));
  }
}

/**
 * Keep business code vendor-neutral. A Langfuse adapter can implement this
 * interface without making workflow execution depend on Langfuse availability.
 */
let sink: ObservabilitySink = new ConsoleSink();

export function setObservabilitySink(next: ObservabilitySink): void {
  sink = next;
}

export function recordAgentTrace(trace: AgentTrace): Promise<void> {
  return Promise.resolve(sink.record(trace));
}
