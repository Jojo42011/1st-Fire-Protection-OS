import { chat } from './llm';
import { rememberFact, rememberEpisode, addEdge } from '../db/memory';

/**
 * Post-conversation memory write. Fire-and-forget — NEVER block the mic-resume / response
 * on this. Extracts durable facts from a conversation and writes them to the brain.
 */
export function extractMemory(agent: string, userText: string, assistantText: string): void {
  // fire-and-forget
  void (async () => {
    try {
      rememberEpisode(agent, `${agent}: ${userText.slice(0, 80)}`, `Q: ${userText}\nA: ${assistantText}`, 0.4);

      const result = await chat(
        [
          {
            role: 'system',
            content:
              'From this exchange, extract 0-3 durable facts as JSON array of {"subject","predicate","object","importance"}. Only stable facts (names, preferences, commitments). Return [] if none.',
          },
          { role: 'user', content: `User: ${userText}\nAssistant: ${assistantText}` },
        ],
        { fast: true, maxTokens: 300 }
      );
      if (!result || !result.text) return;
      const facts = JSON.parse(result.text.replace(/```json|```/g, '').trim());
      if (!Array.isArray(facts)) return;
      for (const f of facts) {
        if (f.subject && f.predicate && f.object) {
          await rememberFact(f.subject, f.predicate, f.object, f.importance || 0.5);
          addEdge(String(f.subject), String(f.predicate), String(f.object));
        }
      }
    } catch (err) {
      console.warn('[extraction] skipped:', (err as Error).message);
    }
  })();
}
