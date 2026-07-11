import { getDb } from '../db/index';
import { chat } from './llm';

/**
 * Periodic self-insight. Reviews recent episodes and writes a synthesis. Runs on a cron
 * from app.ts. No-ops cleanly with no LLM key.
 */
export async function reflect(): Promise<void> {
  try {
    const db = getDb();
    const episodes = db
      .prepare('SELECT agent, summary, detail FROM episodes ORDER BY id DESC LIMIT 25')
      .all() as { agent: string; summary: string; detail: string }[];
    if (episodes.length < 3) return;

    const result = await chat(
      [
        {
          role: 'system',
          content:
            'You are the reflective layer of an AI operating system for a fire-protection company. From these recent episodes, write ONE concise operational insight (a pattern worth remembering). Output only the insight.',
        },
        {
          role: 'user',
          content: episodes.map((e) => `[${e.agent}] ${e.summary}`).join('\n'),
        },
      ],
      { fast: true, maxTokens: 200 }
    );
    if (result && result.text) {
      db.prepare('INSERT INTO syntheses (insight) VALUES (?)').run(result.text);
      console.log('[reflection] wrote synthesis');
    }
  } catch (err) {
    console.warn('[reflection] skipped:', (err as Error).message);
  }
}
