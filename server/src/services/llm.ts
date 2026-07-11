import { MODELS, activeProvider } from '../config/models';

/**
 * Minimal provider-agnostic LLM client (no SDK dependency — plain fetch).
 * Graceful degradation: with no key, callers get a null completion and must fall back
 * to a deterministic template. Never throws on a missing key.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
}

/** Non-streaming chat completion. Returns null when no provider is configured. */
export async function chat(
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; fast?: boolean; maxTokens?: number } = {}
): Promise<LlmResult | null> {
  const provider = activeProvider();
  if (provider === 'none') return null;

  try {
    if (provider === 'anthropic') return await anthropicChat(messages, opts);
    return await openaiChat(messages, opts);
  } catch (err) {
    console.warn('[llm] completion failed, degrading:', (err as Error).message);
    return null;
  }
}

async function anthropicChat(
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; fast?: boolean; maxTokens?: number }
): Promise<LlmResult> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = {
    model: opts.fast ? MODELS.anthropic.fast : MODELS.anthropic.chat,
    max_tokens: opts.maxTokens || 1024,
    system,
    messages: convo,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;

  let text = '';
  const toolCalls: LlmResult['toolCalls'] = [];
  for (const block of data.content || []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') toolCalls.push({ name: block.name, args: block.input || {} });
  }
  return { text: text.trim(), toolCalls };
}

async function openaiChat(
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; fast?: boolean; maxTokens?: number }
): Promise<LlmResult> {
  const body: Record<string, unknown> = {
    model: MODELS.openai.chat,
    max_tokens: opts.maxTokens || 1024,
    messages,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  const msg = data.choices?.[0]?.message || {};

  const toolCalls: LlmResult['toolCalls'] = [];
  for (const tc of msg.tool_calls || []) {
    try {
      toolCalls.push({ name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') });
    } catch {
      toolCalls.push({ name: tc.function.name, args: {} });
    }
  }
  return { text: (msg.content || '').trim(), toolCalls };
}
