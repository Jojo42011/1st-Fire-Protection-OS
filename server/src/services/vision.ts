import { chat } from './llm';

/**
 * Vision helper (optional). Describes an uploaded image (e.g. a photo of a sprinkler riser
 * or an invoice). No-ops to a placeholder when no LLM key is present.
 */
export async function describeImage(_dataUrl: string, hint = ''): Promise<string> {
  // Text-only fallback: vision requires a multimodal model wiring; degrade cleanly.
  const result = await chat(
    [
      {
        role: 'system',
        content:
          'You help a fire-protection company interpret notes about a site photo. Given a short hint, describe what to check. Keep it under 40 words.',
      },
      { role: 'user', content: hint || 'A site photo was uploaded.' },
    ],
    { fast: true, maxTokens: 120 }
  );
  return result?.text || 'Image received. Connect a vision model to auto-analyze site photos.';
}
