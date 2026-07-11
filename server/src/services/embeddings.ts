import { MODELS, embeddingsEnabled } from '../config/models';

/**
 * Embeddings for hybrid memory retrieval. Returns null when no key — memory then
 * falls back to keyword-only scoring. Never throws on a missing key.
 */
export async function embed(text: string): Promise<number[] | null> {
  if (!embeddingsEnabled()) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: MODELS.openai.embed, input: text.slice(0, 8000) }),
    });
    if (!res.ok) throw new Error(`embeddings ${res.status}`);
    const data = (await res.json()) as any;
    return data.data?.[0]?.embedding ?? null;
  } catch (err) {
    console.warn('[embeddings] failed, degrading to keyword-only:', (err as Error).message);
    return null;
  }
}

export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
