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
  // Kimi K3 (Moonshot AI) - the dedicated CODER for the harness. OpenAI-compatible API.
  // Keeps codegen on a strong coding model while Claude stays the reasoning brain.
  // NOTE (K3): the server fixes temperature/top_p/n/penalties - do NOT send them, they 400.
  // reasoning_effort accepts only "max". Context 1M; default max_completion_tokens 131072.
  moonshot: {
    chat: process.env.MOONSHOT_MODEL || 'kimi-k3',
    // "K3 Swarm" has no distinct API model id (it is a subscription concurrency feature), so the
    // swarm runs as parallel kimi-k3 passes. Overridable: if Moonshot ships a real swarm model id,
    // set MOONSHOT_SWARM_MODEL and the swarm passes use it - a one-line swap, no invented ids.
    swarm: process.env.MOONSHOT_SWARM_MODEL || process.env.MOONSHOT_MODEL || 'kimi-k3',
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
 * The CODER: which model writes the harness's agent code. Default is Claude (Opus 4.8) when
 * ANTHROPIC_API_KEY is present, then GPT, then Kimi (Moonshot) only if that is the sole key;
 * with nothing set, the harness emits a real template module. Set CODER=kimi|anthropic|openai
 * to force one (Kimi is opt-in now). Pluggable and swappable per client.
 */
export type Coder = 'kimi' | 'anthropic' | 'openai' | 'none';
export function activeCoder(): Coder {
  const pref = (process.env.CODER || '').toLowerCase();
  if (pref === 'kimi' && process.env.MOONSHOT_API_KEY) return 'kimi';
  if (pref === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (pref === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  // Default preference: Claude (Opus 4.8) codes; then GPT; Kimi only if it is the only key set.
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.MOONSHOT_API_KEY) return 'kimi';
  return 'none';
}
export function coderLabel(): string {
  switch (activeCoder()) {
    case 'kimi':
      return 'Kimi K3';
    case 'anthropic':
      return 'Opus 4.8';
    case 'openai':
      return 'GPT';
    default:
      return 'template';
  }
}

/**
 * When the harness escalates to the swarm (parallel kimi-k3 passes + a reviewer/merge).
 *   'off'  - never; one coder pass per build
 *   'hard' - only for complex/off-catalog builds (default)
 *   'all'  - every build (max quality, max cost)
 * Only meaningful when the coder is Kimi; other coders always run a single pass.
 */
export type SwarmMode = 'off' | 'hard' | 'all';
export function swarmMode(): SwarmMode {
  const v = (process.env.MOONSHOT_SWARM || 'hard').toLowerCase();
  return v === 'off' || v === 'all' ? v : 'hard';
}
/** How many parallel coder passes the swarm runs (clamped 2-5). */
export function swarmSize(): number {
  const n = Number(process.env.MOONSHOT_SWARM_SIZE || 3);
  return Math.max(2, Math.min(5, Number.isFinite(n) ? n : 3));
}

export function embeddingsEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}
