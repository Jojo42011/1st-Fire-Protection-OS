export interface InngestEvent {
  id: string;
  name: string;
  data: Record<string, unknown>;
  user?: Record<string, unknown>;
  ts?: number;
}

export interface InngestPublishResult {
  ids: string[];
}

/**
 * Minimal Event API adapter. Durable function definitions can later use the
 * official SDK, but callers should still depend on Systemize workflow contracts.
 */
export class InngestEventPublisher {
  constructor(
    private readonly eventKey = process.env.INNGEST_EVENT_KEY || '',
    private readonly baseUrl = process.env.INNGEST_EVENT_API_BASE_URL || 'https://inn.gs',
  ) {}

  isConfigured(): boolean {
    return !!this.eventKey;
  }

  async send(event: InngestEvent | InngestEvent[]): Promise<InngestPublishResult> {
    if (!this.eventKey) throw new Error('INNGEST_EVENT_KEY is not configured');
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/e/${encodeURIComponent(this.eventKey)}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.INNGEST_ENV ? { 'x-inngest-env': process.env.INNGEST_ENV } : {}),
      },
      body: JSON.stringify(event),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Inngest ${res.status}: ${text}`);
    const parsed = text ? JSON.parse(text) as { ids?: string[] } : {};
    return { ids: parsed.ids || [] };
  }
}
