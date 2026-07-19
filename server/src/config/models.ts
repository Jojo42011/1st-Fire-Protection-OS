/**
 * Model selection + provider resolution. Graceful degradation is mandatory:
 * with no keys present, the brain runs in "reasoned template" mode and never crashes.
 */

export const MODELS = {
  // Anthropic (preferred for drafting / reflection / extraction)
  anthropic: {
    chat: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    fast: process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001',
  },
  // OpenAI (brain + embeddings for memory)
  openai: {
    chat: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    embed: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
  },
  // Kimi K2 (Moonshot AI) - the dedicated CODER for the harness. OpenAI-compatible API.
  // Keeps codegen on a cheap, strong coding model while Claude stays the reasoning brain.
  moonshot: {
    chat: process.env.MOONSHOT_MODEL || 'kimi-k2-0711-preview',
    baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1',
  },
};

export type Provider = 'anthropic' | 'openai' | 'none';

/** Which LLM provider is live, resolved from env at call time. */
export function activeProvider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

/**
 * The CODER: which model writes the harness's agent code. Kimi K2 (Moonshot) is preferred
 * when its key is present; otherwise the reasoning provider (Claude/OpenAI) codes as a
 * fallback; with nothing set, the harness emits a real template module. Pluggable and
 * swappable per client (a privacy-sensitive client points this back at Claude or local).
 */
export type Coder = 'kimi' | 'anthropic' | 'openai' | 'none';
export function activeCoder(): Coder {
  if (process.env.MOONSHOT_API_KEY) return 'kimi';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}
export function coderLabel(): string {
  switch (activeCoder()) {
    case 'kimi':
      return 'Kimi K2';
    case 'anthropic':
      return 'Claude';
    case 'openai':
      return 'GPT';
    default:
      return 'template';
  }
}

export function embeddingsEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}
