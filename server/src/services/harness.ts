import { getDb } from '../db/index';
import { chat } from './llm';
import { activeProvider } from '../config/models';
import { pillarByKey } from '../config/auditor';
import { capabilityById } from '../config/capabilities';
import { DEPARTMENTS } from '../config/departments';
import { COMPANY } from '../config/constants';

/**
 * THE HARNESS — the execution layer over the Operator's build queue.
 *
 * The Operator finds the gaps and proposes the builds; a human approves one
 * (audit_findings.queue_status = 'approved'); the harness then PICKS IT UP, drafts a
 * build order (the plan to fix it), and stages it for a final human ship. The OS
 * proposes AND builds its own next steps, gated by a person at each hop. Runs keyless
 * (a template plan) and sharpens with an LLM when a key is present.
 */

function safeParse(s: string | null): any[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
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

/** Draft the build plan for one gap. Keyless -> a template; with a key -> a sharper plan. */
async function draftPlan(
  finding: any,
  cap: { id: string; name: string; builds: string }
): Promise<{ steps: string[]; engine: string }> {
  const pillar = pillarByKey(finding.pillar_key)?.name || finding.pillar_key || 'the operation';
  const template = [
    `Scope the fix: ${cap.builds}`,
    `Wire it into the ${pillar} systems and the shared brain`,
    `Prove it removes the leak: "${finding.title}"${finding.cost_hint ? ` (${finding.cost_hint})` : ''}`,
    `Stage for approval, then run it live on the client's own keys`,
  ];
  if (activeProvider() === 'none') return { steps: template, engine: 'harness-rules' };
  try {
    const res = await chat(
      [
        {
          role: 'system',
          content: `You are the build harness inside ${COMPANY.name}'s AI operating system. Given a gap the Operator found and the capability that fixes it, output a tight build plan as a JSON array of 4 short strings (scope, build, wire, verify). No prose, JSON array only.`,
        },
        {
          role: 'user',
          content: `GAP: ${finding.title}\nWHY: ${finding.detail || ''}\nBUILD: ${cap.name} - ${cap.builds}\nPILLAR: ${pillar}`,
        },
      ],
      { maxTokens: 320 }
    );
    if (res?.text) {
      const arr = JSON.parse(res.text.replace(/```json|```/g, '').trim());
      if (Array.isArray(arr) && arr.length) return { steps: arr.map(String).slice(0, 6), engine: 'harness-llm' };
    }
  } catch {
    /* fall through to template */
  }
  return { steps: template, engine: 'harness-rules' };
}

/** Run the harness: turn every newly-approved gap into a staged build order. */
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
    `INSERT INTO build_orders (finding_id, capability_id, title, plan, value_line, eta_weeks, status, engine)
     VALUES (?, ?, ?, ?, ?, ?, 'staged', ?)`
  );
  let built = 0;
  for (const f of approved) {
    const cap = capabilityById(f.capability_id);
    if (!cap) continue;
    const { steps, engine } = await draftPlan(f, cap);
    ins.run(
      f.id,
      cap.id,
      `Build: ${cap.name}`,
      JSON.stringify(steps),
      f.value_line || f.cost_hint || null,
      etaWeeks(cap.id),
      engine
    );
    db.prepare(`UPDATE audit_findings SET queue_status = 'building' WHERE id = ?`).run(f.id);
    built++;
  }
  return { built };
}

/** Ship a staged build order — the human gate that puts the fix live. */
export function shipBuildOrder(id: number): { ok: boolean } {
  const db = getDb();
  const o = db.prepare(`SELECT finding_id FROM build_orders WHERE id = ?`).get(id) as
    | { finding_id: number }
    | undefined;
  db.prepare(`UPDATE build_orders SET status = 'shipped', shipped_at = datetime('now') WHERE id = ?`).run(id);
  if (o?.finding_id) db.prepare(`UPDATE audit_findings SET queue_status = 'shipped' WHERE id = ?`).run(o.finding_id);
  return { ok: true };
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
  ).map((f) => ({
    id: f.id,
    title: f.title,
    pillar: pillarByKey(f.pillar_key)?.name || f.pillar_key,
    severity: f.severity,
    build: capabilityById(f.capability_id)?.name || null,
    value: f.value_line || f.cost_hint || '',
  }));

  const orders = (
    db
      .prepare(
        `SELECT b.*, f.pillar_key
         FROM build_orders b LEFT JOIN audit_findings f ON f.id = b.finding_id
         ORDER BY (b.status = 'shipped') ASC, b.id DESC`
      )
      .all() as any[]
  ).map((o) => ({
    id: o.id,
    title: o.title,
    build: capabilityById(o.capability_id)?.name || o.title,
    pillar: pillarByKey(o.pillar_key)?.name || o.pillar_key,
    plan: safeParse(o.plan),
    value: o.value_line || '',
    eta_weeks: o.eta_weeks,
    status: o.status,
    engine: o.engine,
    shipped_at: o.shipped_at,
  }));

  const staged = orders.filter((o) => o.status === 'staged');
  const shipped = orders.filter((o) => o.status === 'shipped');
  return {
    company: { name: COMPANY.name },
    brain: activeProvider() !== 'none',
    metrics: { pending: inbox.length, staged: staged.length, shipped: shipped.length },
    inbox,
    staged,
    shipped,
  };
}
