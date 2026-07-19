import { getDb } from '../db/index';
import { chat } from './llm';
import { activeProvider } from '../config/models';
import { pillarByKey } from '../config/auditor';
import { capabilityById } from '../config/capabilities';
import { DEPARTMENTS } from '../config/departments';
import { COMPANY } from '../config/constants';
import { CAPABILITY_TO_FOUNDING_AGENT, createAgentFromOrder, getAgent, upgradeAgent } from './agentRuntime';
import { customAgentName } from './auditAgent';
import { generateAgentModule, coderNote } from './codegen';
import { activeCoder, coderLabel } from '../config/models';

interface CapLike {
  id: string | null;
  name: string;
  what: string;
  builds: string;
}

/**
 * THE HARNESS - the build arm of the OS, working hand in hand with the Operator.
 *
 * The Operator finds the gaps and proposes the builds; a human approves one
 * (audit_findings.queue_status = 'approved'); the harness then PICKS IT UP and drafts a
 * build order that either BUILDS A NEW AGENT (a fresh AI employee, defined as data the
 * runtime executes) or STRENGTHENS AN EXISTING ONE (adds skills/knowledge to an agent
 * already on the roster). A human ships it, and the agent goes live / gets smarter. The
 * OS grows its own team, gated by a person at each hop. Runs keyless (templated specs) and
 * sharpens the drafts with an LLM when a key is present.
 */

function safeParse(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Rough build estimate: the matching department agent's honest week count, else 2. */
function etaWeeks(capabilityId: string): number {
  for (const d of DEPARTMENTS) {
    const a = d.agents.find((x) => x.capability_id === capabilityId);
    if (a) return a.weeks || 2;
  }
  return 2;
}

/** Does this capability strengthen a founding agent, or call for a brand-new one? */
function modeFor(capabilityId: string | null): { mode: 'new' | 'upgrade'; target?: string } {
  if (!capabilityId) return { mode: 'new' }; // off-catalog: always a new custom agent
  const founding = CAPABILITY_TO_FOUNDING_AGENT[capabilityId];
  if (founding && getAgent(founding)) return { mode: 'upgrade', target: founding };
  return { mode: 'new' };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

interface AgentSpec {
  key: string;
  name: string;
  role: string;
  system_prompt: string;
  knowledge: string[];
}

/**
 * The build's target: either a catalog capability, or a CUSTOM (off-catalog) agent the
 * Operator invented for a gap the catalog does not cover. This is what lets the team grow
 * beyond the preset roster of builds.
 */
function capForFinding(finding: any): CapLike {
  const c = finding.capability_id ? capabilityById(finding.capability_id) : undefined;
  if (c) return { id: c.id, name: c.name, what: c.what, builds: c.builds };
  const name = customAgentName(finding.title, finding.pillar_key);
  return {
    id: null,
    name,
    what: finding.detail || `Owns "${finding.title}" for the operation`,
    builds: `Close this gap: ${finding.title}.`,
  };
}

/** The keyless, deterministic agent spec for a finding + its (catalog or custom) target. */
function templateSpecFor(finding: any, cap: CapLike): AgentSpec {
  const pillar = pillarByKey(finding.pillar_key)?.name || finding.pillar_key || 'the operation';
  return {
    key: slug(cap.name),
    name: cap.name,
    role: cap.what || `Owns ${cap.name.toLowerCase()} for ${pillar}`,
    system_prompt: `You are ${cap.name}, an AI employee inside ${COMPANY.name}'s operating system, serving the ${pillar} department. Your job: ${cap.builds} You exist because: ${finding.title}. Speak in the company voice: ${COMPANY.brandVoice}. Be concrete and useful, ground every answer in the OS's real data, and never invent facts.`,
    knowledge: [
      `${cap.builds}`,
      `Watch for: ${finding.title}`,
      `Serve the ${pillar} department and write what you learn into the shared brain.`,
    ],
  };
}

/** Draft the concrete agent (new) or the skills to add (upgrade). Keyless template -> LLM-sharpened. */
async function draftBuild(
  finding: any,
  cap: CapLike,
  mode: 'new' | 'upgrade',
  targetName?: string
): Promise<{ spec?: AgentSpec; skills?: string[]; engine: string }> {
  const pillar = pillarByKey(finding.pillar_key)?.name || finding.pillar_key || 'the operation';
  const templateSpec = templateSpecFor(finding, cap);
  const templateKnowledge = templateSpec.knowledge;
  const offCatalog = !cap.id;

  if (activeProvider() === 'none') {
    return mode === 'new'
      ? { spec: templateSpec, engine: 'harness-rules' }
      : { skills: templateKnowledge.slice(0, 2), engine: 'harness-rules' };
  }

  try {
    if (mode === 'new') {
      const res = await chat(
        [
          {
            role: 'system',
            content: `You are the build harness inside ${COMPANY.name}'s AI operating system. Design a new AI employee that fixes a gap the Operator found.${offCatalog ? ' This gap is NOT in the standard build catalog, so invent the right custom agent from scratch, named for what it does.' : ''} Output ONLY JSON: {"name": string, "role": string (one line), "system_prompt": string (2-4 sentences, second person, the company voice), "knowledge": string[] (3-5 concrete skills/facts it starts with)}. No prose.`,
          },
          {
            role: 'user',
            content: `GAP: ${finding.title}\nWHY: ${finding.detail || ''}\n${offCatalog ? 'NO CATALOG MATCH - design a custom agent.' : `CAPABILITY: ${cap.name} - ${cap.builds}`}\nDEPARTMENT: ${pillar}\nSuggested name: ${cap.name}`,
          },
        ],
        { maxTokens: 500 }
      );
      const j = res?.text ? safeParse(res.text.replace(/```json|```/g, '').trim()) : null;
      if (j && j.name && j.system_prompt) {
        return {
          spec: {
            key: slug(j.name),
            name: String(j.name),
            role: String(j.role || templateSpec.role),
            system_prompt: String(j.system_prompt),
            knowledge: Array.isArray(j.knowledge) ? j.knowledge.map(String).slice(0, 6) : templateKnowledge,
          },
          engine: 'harness-llm',
        };
      }
    } else {
      const res = await chat(
        [
          {
            role: 'system',
            content: `You are the build harness inside ${COMPANY.name}'s AI operating system. An existing AI employee (${targetName}) needs to get smarter to close a gap. Output ONLY a JSON array of 2-4 concrete new skills/knowledge lines to add to it. No prose.`,
          },
          {
            role: 'user',
            content: `AGENT: ${targetName}\nGAP: ${finding.title}\nWHY: ${finding.detail || ''}\nCAPABILITY: ${cap.name} - ${cap.builds}`,
          },
        ],
        { maxTokens: 300 }
      );
      const arr = res?.text ? safeParse(res.text.replace(/```json|```/g, '').trim()) : null;
      if (Array.isArray(arr) && arr.length) return { skills: arr.map(String).slice(0, 5), engine: 'harness-llm' };
    }
  } catch {
    /* fall through to template */
  }
  return mode === 'new'
    ? { spec: templateSpec, engine: 'harness-rules' }
    : { skills: templateKnowledge.slice(0, 2), engine: 'harness-rules' };
}

/** Run the harness: turn every newly-approved gap into a staged build order (a drafted agent). */
export async function runHarness(): Promise<{ built: number }> {
  const db = getDb();
  // Every APPROVED gap is buildable - the human approve is the gate. Matched gaps build
  // their catalog agent; unmatched (off-catalog) gaps build a custom agent the Operator named.
  const approved = db
    .prepare(
      `SELECT * FROM audit_findings f
       WHERE f.queue_status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM build_orders b WHERE b.finding_id = f.id)
       ORDER BY f.id DESC`
    )
    .all() as any[];

  const ins = db.prepare(
    `INSERT INTO build_orders (finding_id, capability_id, title, plan, value_line, eta_weeks, status, engine, mode, target_agent_key, code, code_path, code_engine)
     VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?, ?, ?, ?)`
  );
  let built = 0;
  for (const f of approved) {
    const cap = capForFinding(f);
    const { mode, target } = modeFor(cap.id);
    const targetName = target ? getAgent(target)?.name : undefined;
    const draft = await draftBuild(f, cap, mode, targetName);
    const payload =
      mode === 'new'
        ? { mode, spec: draft.spec, off_catalog: !cap.id }
        : { mode, target, target_name: targetName, skills: draft.skills };
    const title =
      mode === 'new'
        ? `${cap.id ? 'New agent' : 'New custom agent'}: ${draft.spec?.name || cap.name}`
        : `Strengthen: ${targetName || target}`;
    // For a NEW agent, the coder (Kimi by default) writes a real, reviewable code module.
    let code: string | null = null,
      codePath: string | null = null,
      codeEngine: string | null = null;
    if (mode === 'new' && draft.spec) {
      // Complex builds (off-catalog, or a deep gap) earn the K3 swarm when it is enabled.
      const complex = !cap.id || (f.detail || '').length > 240;
      const gen = await generateAgentModule(draft.spec, f, cap.name, { complex });
      code = gen.code;
      codePath = gen.path;
      codeEngine = gen.engine;
    }
    ins.run(
      f.id,
      cap.id,
      title,
      JSON.stringify(payload),
      f.value_line || f.cost_hint || null,
      cap.id ? etaWeeks(cap.id) : 2,
      draft.engine,
      mode,
      target || null,
      code,
      codePath,
      codeEngine
    );
    db.prepare(`UPDATE audit_findings SET queue_status = 'building' WHERE id = ?`).run(f.id);
    built++;
  }
  return { built };
}

/** The full finding behind an order (for spec rebuilds / heal). */
function findingFor(db: any, findingId: number | null): any {
  return findingId ? db.prepare(`SELECT * FROM audit_findings WHERE id = ?`).get(findingId) : null;
}

/** Turn a staged (or legacy) 'new' order into a live agent, rebuilding the spec if it is missing. */
function materializeAgent(db: any, o: any): string | undefined {
  const payload = safeParse(o.plan) || {};
  const finding = findingFor(db, o.finding_id);
  // Legacy orders (shipped before agents existed) have no spec - rebuild it keyless from the gap.
  const spec = payload.spec || (finding ? templateSpecFor(finding, capForFinding(finding)) : null);
  if (!spec) return undefined;
  return createAgentFromOrder({
    id: o.id,
    capability_id: o.capability_id,
    pillar_key: finding?.pillar_key || null,
    spec,
  });
}

/** Ship a staged build order - the human gate that puts the agent live / makes it smarter. */
export function shipBuildOrder(id: number): { ok: boolean; result?: string; agentKey?: string } {
  const db = getDb();
  const o = db.prepare(`SELECT * FROM build_orders WHERE id = ? AND status = 'staged'`).get(id) as any;
  if (!o) return { ok: false, result: 'not a staged order' };
  const payload = safeParse(o.plan) || {};

  let result = 'shipped';
  let agentKey: string | undefined;
  if (o.mode === 'upgrade' && o.target_agent_key) {
    const up = upgradeAgent(o.target_agent_key, payload.skills || [], o.id);
    agentKey = o.target_agent_key;
    result = `strengthened ${payload.target_name || o.target_agent_key} (+${up.added} skill${up.added === 1 ? '' : 's'})`;
  } else {
    agentKey = materializeAgent(db, o);
    if (agentKey) result = `${getAgent(agentKey)?.name || 'the agent'} is live in the roster`;
  }

  db.prepare(`UPDATE build_orders SET status = 'shipped', shipped_at = datetime('now') WHERE id = ?`).run(id);
  if (o.finding_id) db.prepare(`UPDATE audit_findings SET queue_status = 'shipped' WHERE id = ?`).run(o.finding_id);
  return { ok: true, result, agentKey };
}

/**
 * Heal the roster: any shipped 'new' order that never produced an agent (e.g. it shipped
 * under an earlier build before agents existed) gets its agent created now. Idempotent -
 * skips orders that already have an agent. Runs on boot so a shipped card never lies about
 * being "live in the roster."
 */
export function healRoster(): number {
  const db = getDb();
  const orphans = db
    .prepare(
      `SELECT * FROM build_orders o
       WHERE o.status = 'shipped' AND (o.mode IS NULL OR o.mode = 'new')
         AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.built_from = o.id)`
    )
    .all() as any[];
  let healed = 0;
  for (const o of orphans) {
    if (materializeAgent(db, o)) healed++;
  }
  return healed;
}

/** The harness pipeline for the UI: inbox (approved, awaiting) -> staged -> shipped. */
export function harnessState() {
  const db = getDb();
  const inbox = (
    db
      .prepare(
        `SELECT * FROM audit_findings f
         WHERE f.queue_status = 'approved'
           AND NOT EXISTS (SELECT 1 FROM build_orders b WHERE b.finding_id = f.id)
         ORDER BY f.id DESC`
      )
      .all() as any[]
  ).map((f) => {
    const cap = capForFinding(f);
    const { mode, target } = modeFor(cap.id);
    return {
      id: f.id,
      title: f.title,
      pillar: pillarByKey(f.pillar_key)?.name || f.pillar_key,
      severity: f.severity,
      mode,
      custom: !cap.id, // off-catalog custom agent
      action: mode === 'new' ? `Build ${cap.name}` : `Strengthen ${target ? getAgent(target)?.name : ''}`,
      value: f.value_line || f.cost_hint || '',
    };
  });

  const orders = (
    db.prepare(`SELECT * FROM build_orders ORDER BY (status = 'shipped') ASC, id DESC`).all() as any[]
  ).map((o) => {
    const payload = safeParse(o.plan) || {};
    const isNew = o.mode !== 'upgrade';
    // Honest "live" signal: a new order only counts as live if its agent actually exists.
    const builtAgent = isNew
      ? (db.prepare(`SELECT key, name FROM agents WHERE built_from = ?`).get(o.id) as any)
      : getAgent(o.target_agent_key);
    return {
      id: o.id,
      mode: o.mode || 'new',
      custom: !!payload.off_catalog,
      title: o.title,
      agent_name: builtAgent?.name || (isNew ? payload.spec?.name : payload.target_name || o.target_agent_key),
      agent_key: builtAgent?.key || (isNew ? undefined : o.target_agent_key),
      agent_built: !!builtAgent,
      role: isNew ? payload.spec?.role : null,
      knowledge: isNew ? payload.spec?.knowledge || [] : payload.skills || [],
      value: o.value_line || '',
      eta_weeks: o.eta_weeks,
      status: o.status,
      engine: o.engine,
      code: o.code || null, // the real module the coder wrote (reviewable artifact)
      code_path: o.code_path || null,
      code_engine: o.code_engine || null,
      shipped_at: o.shipped_at,
    };
  });

  const staged = orders.filter((o) => o.status === 'staged');
  const shipped = orders.filter((o) => o.status === 'shipped');
  const agentCount = (db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE status = 'live'`).get() as any).n;
  const builtCount = (db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE origin = 'harness' AND status = 'live'`).get() as any).n;
  return {
    company: { name: COMPANY.name },
    brain: activeProvider() !== 'none',
    coder: coderLabel(), // who writes the code: Kimi K3 | Claude | GPT | template
    coder_live: activeCoder() !== 'none',
    coder_note: coderNote(), // last codegen diagnostic (ok | api-error:.. | invalid-output:..)
    metrics: {
      pending: inbox.length,
      staged: staged.length,
      shipped: shipped.length,
      agents_live: agentCount,
      agents_built: builtCount,
    },
    inbox,
    staged,
    shipped,
  };
}
