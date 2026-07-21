import { getDb } from '../db/index';
import { chat } from './llm';
import { activeProvider } from '../config/models';
import { memoryContext, rememberEpisode, rememberFact } from '../db/memory';
import { pillarByKey } from '../config/auditor';
import { COMPANY } from '../config/constants';

/**
 * THE AGENT RUNTIME - one generic loop that runs ANY agent defined as data.
 *
 * In this OS an agent is not hardcoded: it is a row in `agents` (a persona, a pillar, a
 * capability, and a growing knowledge/skill list). This runtime executes that row exactly
 * the way the founding agents run: assemble the persona + its own knowledge + the shared
 * brain's memory + live company facts, call the LLM, and (keyless) fall back to a grounded
 * deterministic reply. That is what lets the Harness CREATE new working agents without
 * writing code: it just writes the data this runtime already knows how to run.
 *
 * Every turn also writes back into the shared brain, so each agent's work makes the whole
 * OS a little smarter (the moat, literal).
 */

export interface AgentRow {
  id: number;
  key: string;
  name: string;
  role: string | null;
  pillar_key: string | null;
  capability_id: string | null;
  system_prompt: string | null;
  knowledge: string | null;
  origin: string;
  status: string;
  built_from: number | null;
  dashboard_kind: string | null; // 'dashboard' (built agents own a sub-dashboard) | 'console'
  created_at: string;
}

/** The founding capabilities map to the founding agents (for the strengthen path). */
export const CAPABILITY_TO_FOUNDING_AGENT: Record<string, string> = {
  ai_receptionist: 'calls',
  invoice_chaser: 'invoices',
  review_engine: 'reviews',
};

function parseKnowledge(row: AgentRow | undefined): string[] {
  if (!row?.knowledge) return [];
  try {
    const v = JSON.parse(row.knowledge);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function getAgent(key: string): AgentRow | undefined {
  return getDb().prepare(`SELECT * FROM agents WHERE key = ?`).get(key) as AgentRow | undefined;
}

/** The whole team: founding + harness-built, each with its skill count and knowledge. */
export function listAgents(): any[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM agents ORDER BY (origin = 'founding') DESC, id ASC`).all() as AgentRow[];
  return rows.map((r) => {
    const skills = db
      .prepare(`SELECT skill, created_at FROM agent_skills WHERE agent_key = ? ORDER BY id DESC`)
      .all(r.key) as { skill: string; created_at: string }[];
    return {
      key: r.key,
      name: r.name,
      role: r.role,
      pillar_key: r.pillar_key,
      pillar: r.pillar_key ? pillarByKey(r.pillar_key)?.name || r.pillar_key : null,
      capability_id: r.capability_id,
      origin: r.origin, // founding | harness
      status: r.status,
      built_from: r.built_from,
      dashboard_kind: r.dashboard_kind || (r.origin === 'harness' ? 'dashboard' : 'console'),
      created_at: r.created_at,
      knowledge: parseKnowledge(r),
      skills: skills.map((s) => s.skill),
      skill_count: skills.length,
    };
  });
}

/** Assemble this agent's system prompt: its persona + its knowledge + shared memory + live facts. */
async function assembleSystem(agent: AgentRow, userText: string): Promise<string> {
  const pillar = agent.pillar_key ? pillarByKey(agent.pillar_key)?.name : null;
  const knowledge = parseKnowledge(agent);
  const persona =
    agent.system_prompt ||
    `You are ${agent.name}, an AI employee inside ${COMPANY.name}'s operating system. Your job: ${agent.role || 'serve the ' + (pillar || 'operation')}. Speak in the company's voice: ${COMPANY.brandVoice}. Be concrete and useful; never invent facts you were not given.`;
  const know = knowledge.length ? `What you know / your skills:\n- ${knowledge.join('\n- ')}` : '';
  const live = `Company: ${COMPANY.name}. Industry: ${COMPANY.industry}. Area: ${COMPANY.area}.${pillar ? ` You serve the ${pillar} department.` : ''}`;
  const mem = await memoryContext(userText);
  return [persona, know, live, mem].filter(Boolean).join('\n\n');
}

/** Grounded keyless reply - an agent still does real, specific work with no LLM key. */
function degradedReply(agent: AgentRow, userText: string): string {
  const pillar = agent.pillar_key ? pillarByKey(agent.pillar_key)?.name : 'the operation';
  const knowledge = parseKnowledge(agent);
  const skillLine = knowledge.length ? ` I already know: ${knowledge.slice(0, 3).join('; ')}.` : '';
  return (
    `${agent.name} here - ${agent.role || 'working ' + pillar} for ${COMPANY.name}.` +
    skillLine +
    ` I'm running in offline mode right now; add an Anthropic or OpenAI key and I'll handle "${userText.slice(0, 80)}" end to end. I'm live in the roster either way.`
  );
}

/** Run one turn of a data-defined agent. Writes what it did back into the shared brain. */
export async function runAgent(key: string, userText: string): Promise<{ ok: boolean; text: string; agent?: string }> {
  const agent = getAgent(key);
  if (!agent) return { ok: false, text: 'No such agent.' };
  if (agent.status !== 'live') return { ok: false, text: `${agent.name} is not live yet.` };

  let text: string;
  if (activeProvider() === 'none') {
    text = degradedReply(agent, userText);
  } else {
    const system = await assembleSystem(agent, userText);
    const res = await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
      { maxTokens: 700 }
    );
    text = res?.text || degradedReply(agent, userText);
  }

  // Every turn makes the whole OS smarter: log the episode into the shared brain.
  try {
    rememberEpisode(agent.key, `${agent.name} handled: ${userText.slice(0, 120)}`, text.slice(0, 400), 0.4);
  } catch {
    /* memory is best-effort */
  }
  return { ok: true, text, agent: agent.name };
}

/** CREATE a new live agent from a shipped build order's drafted spec. Returns the new key. */
export function createAgentFromOrder(order: {
  id: number;
  capability_id: string | null;
  pillar_key?: string | null;
  spec: { key: string; name: string; role: string; system_prompt: string; knowledge: string[] };
}): string {
  const db = getDb();
  // Ensure a unique key even if two builds share a base slug.
  let key = order.spec.key;
  let n = 2;
  while (db.prepare(`SELECT 1 FROM agents WHERE key = ?`).get(key)) key = `${order.spec.key}-${n++}`;

  db.prepare(
    `INSERT INTO agents (key, name, role, pillar_key, capability_id, system_prompt, knowledge, origin, status, built_from, dashboard_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'harness', 'live', ?, 'dashboard')`
  ).run(
    key,
    order.spec.name,
    order.spec.role,
    order.pillar_key || null,
    order.capability_id,
    order.spec.system_prompt,
    JSON.stringify(order.spec.knowledge || []),
    order.id
  );
  const skillIns = db.prepare(`INSERT INTO agent_skills (agent_key, skill, source_order) VALUES (?, ?, ?)`);
  for (const s of order.spec.knowledge || []) skillIns.run(key, s, order.id);

  // Record the new hire in the shared brain so the rest of the OS knows the team grew.
  try {
    void rememberFact(order.spec.name, 'is a live AI employee in', COMPANY.name);
    rememberEpisode('harness', `Built and shipped a new agent: ${order.spec.name}`, order.spec.role, 0.7);
  } catch {
    /* best-effort */
  }
  return key;
}

/** STRENGTHEN an existing agent: append new skills to its knowledge + log them. */
export function upgradeAgent(targetKey: string, skills: string[], sourceOrder: number): { ok: boolean; added: number } {
  const db = getDb();
  const agent = getAgent(targetKey);
  if (!agent) return { ok: false, added: 0 };
  const current = parseKnowledge(agent);
  const fresh = skills.filter((s) => s && !current.includes(s));
  const merged = current.concat(fresh);
  db.prepare(`UPDATE agents SET knowledge = ? WHERE key = ?`).run(JSON.stringify(merged), targetKey);
  const skillIns = db.prepare(`INSERT INTO agent_skills (agent_key, skill, source_order) VALUES (?, ?, ?)`);
  for (const s of fresh) skillIns.run(targetKey, s, sourceOrder);
  try {
    rememberEpisode('harness', `Strengthened ${agent.name}`, fresh.join('; '), 0.6);
  } catch {
    /* best-effort */
  }
  return { ok: true, added: fresh.length };
}
