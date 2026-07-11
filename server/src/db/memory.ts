import { getDb } from './index';
import { embed, cosine } from '../services/embeddings';

/**
 * The "brain" memory: facts / episodes / graph / rules / syntheses, with hybrid retrieval
 * (embedding cosine + keyword + strength + recency + importance). Falls back to keyword-only
 * when no embeddings key is present.
 */

export interface Fact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  importance: number;
  strength: number;
  embedding: string | null;
  created_at: string;
}

export async function rememberFact(
  subject: string,
  predicate: string,
  object: string,
  importance = 0.5
): Promise<void> {
  const db = getDb();
  const text = `${subject} ${predicate} ${object}`;
  const vec = await embed(text);
  db.prepare(
    `INSERT INTO facts (subject, predicate, object, importance, embedding)
     VALUES (?, ?, ?, ?, ?)`
  ).run(subject, predicate, object, importance, vec ? JSON.stringify(vec) : null);
}

export function rememberEpisode(agent: string, summary: string, detail = '', importance = 0.5): void {
  getDb()
    .prepare(`INSERT INTO episodes (agent, summary, detail, importance) VALUES (?, ?, ?, ?)`)
    .run(agent, summary, detail, importance);
}

export function addRule(rule: string, scope = 'global'): void {
  getDb().prepare(`INSERT INTO rules (rule, scope) VALUES (?, ?)`).run(rule, scope);
}

export function activeRules(scope?: string): string[] {
  const db = getDb();
  const rows = scope
    ? db.prepare(`SELECT rule FROM rules WHERE active = 1 AND (scope = ? OR scope = 'global')`).all(scope)
    : db.prepare(`SELECT rule FROM rules WHERE active = 1`).all();
  return (rows as { rule: string }[]).map((r) => r.rule);
}

function keywordScore(query: string, text: string): number {
  const q = query.toLowerCase().split(/\W+/).filter(Boolean);
  if (!q.length) return 0;
  const t = text.toLowerCase();
  let hits = 0;
  for (const w of q) if (t.includes(w)) hits++;
  return hits / q.length;
}

/** Hybrid retrieval of the most relevant facts for a query. */
export async function recallFacts(query: string, limit = 6): Promise<Fact[]> {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM facts`).all() as Fact[];
  if (!rows.length) return [];

  const qvec = await embed(query);
  const now = Date.now();

  const scored = rows.map((f) => {
    const text = `${f.subject} ${f.predicate} ${f.object}`;
    let semantic = 0;
    if (qvec && f.embedding) {
      try {
        semantic = cosine(qvec, JSON.parse(f.embedding));
      } catch {
        semantic = 0;
      }
    }
    const keyword = keywordScore(query, text);
    const ageDays = (now - new Date(f.created_at + 'Z').getTime()) / 86400000;
    const recency = 1 / (1 + Math.max(0, ageDays) / 30);
    const score =
      0.45 * semantic + 0.3 * keyword + 0.15 * (f.importance || 0.5) + 0.1 * recency * (f.strength || 1);
    return { f, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.f);
}

/** Build a compact memory-context string for the system prompt. */
export async function memoryContext(query: string): Promise<string> {
  const [facts, rules] = [await recallFacts(query, 5), activeRules()];
  const parts: string[] = [];
  if (facts.length) {
    parts.push('Relevant memory:');
    for (const f of facts) parts.push(`- ${f.subject} ${f.predicate} ${f.object}`);
  }
  if (rules.length) {
    parts.push('Operating rules:');
    for (const r of rules) parts.push(`- ${r}`);
  }
  return parts.join('\n');
}

/* ---------- knowledge graph ---------- */
export function upsertNode(label: string, kind = 'entity'): number {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO nodes (label, kind) VALUES (?, ?)`).run(label, kind);
  const row = db.prepare(`SELECT id FROM nodes WHERE label = ? AND kind = ?`).get(label, kind) as {
    id: number;
  };
  return row.id;
}

export function addEdge(srcLabel: string, relation: string, dstLabel: string, weight = 1.0): void {
  const src = upsertNode(srcLabel);
  const dst = upsertNode(dstLabel);
  getDb()
    .prepare(`INSERT INTO edges (src, dst, relation, weight) VALUES (?, ?, ?, ?)`)
    .run(src, dst, relation, weight);
}
