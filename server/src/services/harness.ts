import { getDb } from '../db/index';
import { chat } from './llm';
import { activeProvider } from '../config/models';
import { pillarByKey } from '../config/auditor';
import { capabilityById } from '../config/capabilities';
import { DEPARTMENTS } from '../config/departments';
import { COMPANY } from '../config/constants';
import { CAPABILITY_TO_FOUNDING_AGENT, createAgentFromOrder, getAgent, upgradeAgent } from './agentRuntime';

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
function modeFor(capabilityId: string): { mode: 'new' | 'upgrade'; target?: string } {
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

/** Draft the concrete agent (new) or the skills to add (upgrade). Keyless template -> LLM-sharpened. */
async function draftBuild(
  finding: any,
  cap: { id: string; name: string; what: string; builds: string },
  mode: 'new' | 'upgrade',
  targetName?: string
): Promise<{ spec?: AgentSpec; skills?: string[]; engine: string }> {
  const pillar = pillarByKey(finding.pillar_key)?.name || finding.pillar_key || 'the operation';

  // keyless templates - real and specific, grounded in the capability + the gap.
  const templateKnowledge = [
    `${cap.builds}`,
    `Watch for: ${finding.title}`,
    `Serve the ${pillar} department and write what you learn into the shared brain.`,
  ];
  const templateSpec: AgentSpec = {
    key: slug(cap.name),
    name: cap.name,
    role: cap.what || `Owns ${cap.name.toLowerCase()} for ${pillar}`,
    system_prompt: `You are ${cap.name}, an AI employee inside ${COMPANY.name}'s operating system, serving the ${pillar} department. Your job: ${cap.builds} You exist because: ${finding.title}. Speak in the company voice: ${COMPANY.brandVoice}. Be concrete and useful, ground every answer in the OS's real data, and never invent facts.`,
    knowledge: templateKnowledge,
  };

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
            content: `You are the build harness inside ${COMPANY.name}'s AI operating system. Design a new AI employee that fixes a gap the Operator found. Output ONLY JSON: {"name": string, "role": string (one line), "system_prompt": string (2-4 sentences, second person, the company voice), "knowledge": string[] (3-5 concrete skills/facts it starts with)}. No prose.`,
          },
          {
            role: 'user',
            content: `GAP: ${finding.title}\nWHY: ${finding.detail || ''}\nCAPABILITY: ${cap.name} - ${cap.builds}\nDEPARTMENT: ${pillar}\nSuggested name: ${cap.name}`,
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
  const approved = db
    .prepare(
      `SELECT * FROM audit_findings f
       WHERE f.queue_status = 'approved' AND f.capability_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM build_orders b WHERE b.finding_id = f.id)
       ORDER BY f.id DESC`
    )
    .all() as any[];

  const ins = db.prepare(
    `INSERT INTO build_orders (finding_id, capability_id, title, plan, value_line, eta_weeks, status, engine, mode, target_agent_key)
     VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?)`
  );
  let built = 0;
  for (const f of approved) {
    const cap = capabilityById(f.capability_id);
    if (!cap) continue;
    const { mode, target } = modeFor(cap.id);
    const targetName = target ? getAgent(target)?.name : undefined;
    const draft = await draftBuild(f, cap, mode, targetName);
    const payload =
      mode === 'new'
        ? { mode, spec: draft.spec }
        : { mode, target, target_name: targetName, skills: draft.skills };
    const title = mode === 'new' ? `New agent: ${draft.spec?.name || cap.name}` : `Strengthen: ${targetName || target}`;
    ins.run(
      f.id,
      cap.id,
      title,
      JSON.stringify(payload),
      f.value_line || f.cost_hint || null,
      etaWeeks(cap.id),
      draft.engine,
      mode,
      target || null
    );
    db.prepare(`UPDATE audit_findings SET queue_status = 'building' WHERE id = ?`).run(f.id);
    built++;
  }
  return { built };
}

/** Ship a staged build order - the human gate that puts the agent live / makes it smarter. */
export function shipBuildOrder(id: number): { ok: boolean; result?: string; agentKey?: string } {
  const db = getDb();
  const o = db.prepare(`SELECT * FROM build_orders WHERE id = ? AND status = 'staged'`).get(id) as any;
  if (!o) return { ok: false, result: 'not a staged order' };
  const payload = safeParse(o.plan) || {};
  const finding = o.finding_id
    ? (db.prepare(`SELECT pillar_key FROM audit_findings WHERE id = ?`).get(o.finding_id) as any)
    : null;

  let result = 'shipped';
  let agentKey: string | undefined;
  if (o.mode === 'upgrade' && o.target_agent_key) {
    const up = upgradeAgent(o.target_agent_key, payload.skills || [], o.id);
    agentKey = o.target_agent_key;
    result = `strengthened ${payload.target_name || o.target_agent_key} (+${up.added} skill${up.added === 1 ? '' : 's'})`;
  } else if (payload.spec) {
    agentKey = createAgentFromOrder({
      id: o.id,
      capability_id: o.capability_id,
      pillar_key: finding?.pillar_key || null,
      spec: payload.spec,
    });
    result = `${payload.spec.name} is live in the roster`;
  }

  db.prepare(`UPDATE build_orders SET status = 'shipped', shipped_at = datetime('now') WHERE id = ?`).run(id);
  if (o.finding_id) db.prepare(`UPDATE audit_findings SET queue_status = 'shipped' WHERE id = ?`).run(o.finding_id);
  return { ok: true, result, agentKey };
}

/** The harness pipeline for the UI: inbox (approved, awaiting) -> staged -> shipped. */
export function harnessState() {
  const db = getDb();
  const inbox = (
    db
      .prepare(
        `SELECT id, title, pillar_key, severity, capability_id, value_line, cost_hint
         FROM audit_findings f
         WHERE f.queue_status = 'approved' AND f.capability_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM build_orders b WHERE b.finding_id = f.id)
         ORDER BY f.id DESC`
      )
      .all() as any[]
  ).map((f) => {
    const { mode, target } = modeFor(f.capability_id);
    const cap = capabilityById(f.capability_id);
    return {
      id: f.id,
      title: f.title,
      pillar: pillarByKey(f.pillar_key)?.name || f.pillar_key,
      severity: f.severity,
      mode,
      action: mode === 'new' ? `Build ${cap?.name || 'a new agent'}` : `Strengthen ${target ? getAgent(target)?.name : ''}`,
      value: f.value_line || f.cost_hint || '',
    };
  });

  const orders = (
    db.prepare(`SELECT * FROM build_orders ORDER BY (status = 'shipped') ASC, id DESC`).all() as any[]
  ).map((o) => {
    const payload = safeParse(o.plan) || {};
    const isNew = o.mode !== 'upgrade';
    return {
      id: o.id,
      mode: o.mode || 'new',
      title: o.title,
      agent_name: isNew ? payload.spec?.name : payload.target_name || o.target_agent_key,
      agent_key: isNew ? undefined : o.target_agent_key,
      role: isNew ? payload.spec?.role : null,
      knowledge: isNew ? payload.spec?.knowledge || [] : payload.skills || [],
      value: o.value_line || '',
      eta_weeks: o.eta_weeks,
      status: o.status,
      engine: o.engine,
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
