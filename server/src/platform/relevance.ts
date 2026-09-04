export interface RelevanceTriggerRequest {
  agentId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RelevanceTriggerResult {
  ok: boolean;
  status: number;
  data?: unknown;
}

/**
 * Relevance AI is a reasoning/workforce layer, not a state store. The API URL is
 * region-specific and is copied from the agent API trigger configuration.
 */
export class RelevanceClient {
  constructor(
    private readonly apiUrl = process.env.RELEVANCE_API_URL || '',
    private readonly apiKey = process.env.RELEVANCE_API_KEY || '',
  ) {}

  isConfigured(): boolean {
    return !!(this.apiUrl && this.apiKey);
  }

  async trigger(input: RelevanceTriggerRequest): Promise<RelevanceTriggerResult> {
    if (!this.apiUrl) throw new Error('RELEVANCE_API_URL is not configured');
    if (!this.apiKey) throw new Error('RELEVANCE_API_KEY is not configured');

    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: input.agentId,
        message: { role: 'user', content: input.content },
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }),
    });

    const text = await res.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : undefined; } catch { /* keep raw text */ }
    if (!res.ok) throw new Error(`Relevance AI ${res.status}: ${text}`);
    return { ok: true, status: res.status, data };
  }
}
