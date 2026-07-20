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

  // ── spread activation: the query's directly-matched nodes pull in their strongest
  // current associates (1 hop, capped) as extra candidate context. Co-retrieving two
  // direct nodes for one query is a real co-activation, so reinforce that pair. ──
  try {
    const now = Date.now();
    const direct = matchNodes(query, 4);
    if (direct.length > 1) reinforceCoActivation(direct.map((d) => d.id), new Date(now).toISOString());
    const spread = spreadActivate(direct.map((d) => d.id), 2, now).slice(0, 3);
    if (spread.length) {
      parts.push('Associated in memory (surfaced by connection, weighed as candidates):');
      for (const s of spread) parts.push(`- ${s.label} (keeps coming up with ${s.via})`);
    }
  } catch {
    /* association is a recall aid; never block the prompt on it */
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

export function findNodeByLabel(label: string, kind?: string): number | null {
  const db = getDb();
  const row = kind
    ? (db.prepare(`SELECT id FROM nodes WHERE label = ? AND kind = ?`).get(label, kind) as { id: number } | undefined)
    : (db.prepare(`SELECT id FROM nodes WHERE label = ?`).get(label) as { id: number } | undefined);
  return row ? row.id : null;
}

/* ---------- the associative memory layer (decaying association graph) ----------
 * Associative edges are stored on the existing `edges` table with relation='assoc' and an
 * undirected canonical ordering (src = min(id), dst = max(id)), so they never collide with
 * the typed edges written by extraction. Weight is reinforced with diminishing returns on
 * real co-activation and decayed lazily at read from last_reinforced_at. No scheduler. */

const ASSOC_K = 0.3; // reinforcement step (diminishing returns)
const HALF_LIFE_DAYS = 30; // association half-life
const ASSOC_FLOOR = 0.03; // effective-weight floor below which an association is stale

function parseTs(ts: string): number {
  // All associative timestamps are written as full ISO (…Z). Guard anything else.
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? 0 : t;
}

/** Effective (decayed) weight of an association at nowMs: weight * 0.5 ^ (ageDays / halfLife). */
export function decayedWeight(weight: number, lastReinforcedAt: string | null, nowMs: number): number {
  if (!weight) return 0;
  if (!lastReinforcedAt) return weight; // never stamped: treat raw (no age known)
  const ageDays = Math.max(0, (nowMs - parseTs(lastReinforcedAt)) / 86400000);
  return weight * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/** Reinforce one undirected association with diminishing returns; upsert the edge if absent. */
export function reinforce(aId: number, bId: number, at: string, k = ASSOC_K): void {
  if (!aId || !bId || aId === bId) return;
  const src = Math.min(aId, bId);
  const dst = Math.max(aId, bId);
  const db = getDb();
  const row = db
    .prepare(`SELECT id, weight FROM edges WHERE src = ? AND dst = ? AND relation = 'assoc'`)
    .get(src, dst) as { id: number; weight: number } | undefined;
  if (row) {
    const w = Math.min(1, Math.max(0, row.weight + k * (1 - row.weight)));
    db.prepare(`UPDATE edges SET weight = ?, last_reinforced_at = ? WHERE id = ?`).run(w, at, row.id);
  } else {
    const w = Math.min(1, k * (1 - 0)); // first touch: from 0
    db.prepare(
      `INSERT INTO edges (src, dst, relation, weight, last_reinforced_at, sample) VALUES (?, ?, 'assoc', ?, ?, 0)`
    ).run(src, dst, w, at);
  }
}

/** Reinforce every pair among a set of co-activated nodes (real co-occurrence in one turn). */
export function reinforceCoActivation(nodeIds: number[], at: string, k = ASSOC_K): void {
  const ids = Array.from(new Set(nodeIds.filter(Boolean)));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) reinforce(ids[i], ids[j], at, k);
  }
}

/** The combined loop, confirmed side: extra-reinforce every association incident to a node. */
export function boostNodeEdges(nodeId: number, at: string, k = ASSOC_K): number {
  if (!nodeId) return 0;
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, weight FROM edges WHERE (src = ? OR dst = ?) AND relation = 'assoc'`)
    .all(nodeId, nodeId) as { id: number; weight: number }[];
  for (const r of rows) {
    const w = Math.min(1, Math.max(0, r.weight + k * (1 - r.weight)));
    db.prepare(`UPDATE edges SET weight = ?, last_reinforced_at = ? WHERE id = ?`).run(w, at, r.id);
  }
  return rows.length;
}

/** The combined loop, refuted side: decay every association incident to a node faster (halve). */
export function decayNodeEdges(nodeId: number, at: string, mult = 0.5): number {
  if (!nodeId) return 0;
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, weight FROM edges WHERE (src = ? OR dst = ?) AND relation = 'assoc'`)
    .all(nodeId, nodeId) as { id: number; weight: number }[];
  for (const r of rows) {
    db.prepare(`UPDATE edges SET weight = ?, last_reinforced_at = ? WHERE id = ?`).run(r.weight * mult, at, r.id);
  }
  return rows.length;
}

export interface Association {
  aId: number;
  bId: number;
  a: string;
  b: string;
  aKind: string | null;
  bKind: string | null;
  weight: number; // decayed (current) weight, 0..1
  raw: number; // stored weight before decay
  reason: string;
  sample: boolean;
  lastReinforcedAt: string | null;
}

interface EdgeRow {
  id: number;
  src: number;
  dst: number;
  weight: number;
  last_reinforced_at: string | null;
  sample: number;
  a_label: string;
  a_kind: string | null;
  b_label: string;
  b_kind: string | null;
}

/** Top current associations by decayed weight, with plain-words reasons. Computed at read. */
export function topAssociations(limit = 8, nowMs = Date.now()): Association[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.id, e.src, e.dst, e.weight, e.last_reinforced_at, e.sample,
              a.label AS a_label, a.kind AS a_kind, b.label AS b_label, b.kind AS b_kind
         FROM edges e
         JOIN nodes a ON a.id = e.src
         JOIN nodes b ON b.id = e.dst
        WHERE e.relation = 'assoc'`
    )
    .all() as EdgeRow[];
  return rows
    .map((r) => {
      const w = decayedWeight(r.weight, r.last_reinforced_at, nowMs);
      return {
        aId: r.src,
        bId: r.dst,
        a: r.a_label,
        b: r.b_label,
        aKind: r.a_kind,
        bKind: r.b_kind,
        weight: Math.round(w * 100) / 100,
        raw: Math.round(r.weight * 100) / 100,
        reason: `keeps coming up with "${r.b_label}"`,
        sample: !!r.sample,
        lastReinforcedAt: r.last_reinforced_at,
      };
    })
    .filter((x) => x.weight >= ASSOC_FLOOR)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

/** Spread activation: each direct node's top-k strongest CURRENT associates, 1 hop only. */
export function spreadActivate(
  directNodeIds: number[],
  k = 3,
  nowMs = Date.now()
): { nodeId: number; label: string; viaId: number; via: string; weight: number }[] {
  const direct = new Set(directNodeIds.filter(Boolean));
  if (!direct.size) return [];
  const db = getDb();
  const out = new Map<number, { nodeId: number; label: string; viaId: number; via: string; weight: number }>();
  for (const id of direct) {
    const rows = db
      .prepare(
        `SELECT e.src, e.dst, e.weight, e.last_reinforced_at,
                a.label AS a_label, b.label AS b_label
           FROM edges e
           JOIN nodes a ON a.id = e.src
           JOIN nodes b ON b.id = e.dst
          WHERE e.relation = 'assoc' AND (e.src = ? OR e.dst = ?)`
      )
      .all(id, id) as (EdgeRow & { a_label: string; b_label: string })[];
    const cands = rows
      .map((r) => {
        const otherId = r.src === id ? r.dst : r.src;
        const otherLabel = r.src === id ? r.b_label : r.a_label;
        const viaLabel = r.src === id ? r.a_label : r.b_label;
        return { otherId, otherLabel, viaLabel, weight: decayedWeight(r.weight, r.last_reinforced_at, nowMs) };
      })
      .filter((c) => c.weight >= 0.05 && !direct.has(c.otherId))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, k);
    for (const c of cands) {
      const prev = out.get(c.otherId);
      if (!prev || c.weight > prev.weight) {
        out.set(c.otherId, { nodeId: c.otherId, label: c.otherLabel, viaId: id, via: c.viaLabel, weight: c.weight });
      }
    }
  }
  return Array.from(out.values()).sort((a, b) => b.weight - a.weight);
}

/** Direct nodes whose label keyword-matches the query (the seed of spread activation). */
function matchNodes(query: string, cap = 4): { id: number; label: string }[] {
  const db = getDb();
  const rows = db.prepare(`SELECT id, label FROM nodes`).all() as { id: number; label: string }[];
  return rows
    .map((n) => ({ n, score: keywordScore(query, n.label) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((x) => x.n);
}
