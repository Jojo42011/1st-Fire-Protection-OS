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
};

export type Provider = 'anthropic' | 'openai' | 'none';

/** Which LLM provider is live, resolved from env at call time. */
export function activeProvider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

export function embeddingsEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}
