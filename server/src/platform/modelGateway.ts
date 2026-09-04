import type { ModelRequest, ModelResponse } from './contracts';

export interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * Thin HTTP gateway for OpenRouter. Business workflows depend on ModelGateway,
 * not OpenRouter itself, so a direct Anthropic/OpenAI/Google/xAI adapter can
 * replace it later without rewriting workflow logic.
 */
export class OpenRouterGateway implements ModelGateway {
  constructor(
    private readonly apiKey = process.env.OPENROUTER_API_KEY || '',
    private readonly defaultModel = process.env.OPENROUTER_MODEL || '',
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
    const model = request.preferredModel || this.defaultModel;
    if (!model) throw new Error('No model configured: set OPENROUTER_MODEL or request.preferredModel');

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(process.env.PUBLIC_BASE_URL ? { 'HTTP-Referer': process.env.PUBLIC_BASE_URL } : {}),
        'X-Title': '1st Fire Protection OS',
      },
      body: JSON.stringify({ model, messages: request.messages }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);

    const json = await res.json() as any;
    return {
      text: String(json?.choices?.[0]?.message?.content || ''),
      provider: String(json?.provider || 'openrouter'),
      model: String(json?.model || model),
      usage: {
        inputTokens: json?.usage?.prompt_tokens,
        outputTokens: json?.usage?.completion_tokens,
        costUsd: json?.usage?.cost,
      },
      raw: json,
    };
  }
}

/**
 * Existing direct providers remain valid. New production workflow code should
 * receive a ModelGateway through composition rather than importing vendor SDKs.
 */
export function defaultModelGateway(): ModelGateway | null {
  if (process.env.OPENROUTER_API_KEY) return new OpenRouterGateway();
  return null;
}
