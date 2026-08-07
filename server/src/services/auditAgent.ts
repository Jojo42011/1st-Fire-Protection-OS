import { getDb } from '../db/index';
import { chat } from './llm';
import { activeProvider } from '../config/models';
import { OPERATOR_SYSTEM_PROMPT, PILLARS, pillarByKey } from '../config/auditor';
import { CAPABILITIES, capabilityById } from '../config/capabilities';
import { COMPANY } from '../config/constants';
import { rememberFact, rememberEpisode, upsertNode, reinforceCoActivation, topAssociations } from '../db/memory';
import { createPredictionForFinding, calibration } from './calibration';

/**
 * THE OPERATOR — audit engine.
 *
 * capture(text) is the live-session hero: one observation in → classified pillars,
 * findings (benchmark-cited), matched capabilities, and the next consultant questions out —
 * then persisted so the map fills in on screen.
 *
 * Graceful degradation is non-negotiable here: with no LLM key, a deterministic rules
 * engine (keyword triggers from the capability catalog + pillar heuristics) still
 * classifies, matches, and asks — the keyless demo must land the moment.
 */

/* ─────────────────────────── types ─────────────────────────── */

export interface Analysis {
  pillars: string[];
  systems: { name: string; category?: string; truth_for?: string; gaps?: string; pillar?: string }[];
  people: { name: string; role?: string; carries?: string; risk?: string; pillar?: string }[];
  workflows: { name: string; trigger?: string; stalls?: string; pillar?: string }[];
  findings: {
    pillar?: string;
    kind?: string;
    title: string;
    detail?: string;
    severity?: string;
    cost_hint?: string;
  }[];
  capabilities: { id: string; pitch: string }[];
  questions: string[];
  engine: 'operator-llm' | 'operator-rules';
}

/* ─────────────────── deterministic fallback brain ─────────────────── */

const PILLAR_HINTS: [string, RegExp][] = [
  ['inspections', /inspect|itm|nfpa|annual|quarterly|tag\b|test(ing)?|backflow|hydro|agreement|renewal/i],
  ['service', /repair|service call|emergency|on.?call|after.?hours|leak|break|fix|deficien|alarm going|dispatch|schedul|route|truck|windshield|tech(nician)?s?\b/i],
  ['sales', /quote|estimat|bid|proposal|sales|price|margin|win rate|lead|referral|review|reputation/i],
  ['projects', /project|permit|ahj|jurisdiction|marshal|code|submittal|closeout|install\b|citation|violation/i],
  ['finance', /invoice|receivab|collect|owe|payab|billing|cash|dso|aging|quickbooks|account|payment/i],
  ['hr', /hir(e|ing)|recruit|onboard|training|cert(ification)?s?\b|license|apprentice|new (tech|guy|hire)|staff/i],
  ['ops', /complain|escalat|dashboard|kpi|visibility|branch(es)?|location|side.?by.?side|retir|in (his|her|their) head|only one|tribal|veteran|knows every/i],
  ['vendors', /vendor|supplier|procure|purchase|po\b|pricing|material/i],
  ['reception', /front desk|phone|call(s|er)?\b|message|reception|answer|voicemail|sticky|spanish/i],
  ['growth', /grow(th|ing)?|expand|expansion|market share|new (market|metro|territory)|acqui|recurring|white ?space|take over|competitor|permit|new construction|bid board|\brfp\b|\bisd\b|acceptance test|sfmo|austin|houston|dallas|dfw/i],
];

/** Fallback follow-ups per department — the deck's own consulting questions. */
import { DEPARTMENTS } from '../config/departments';
const PILLAR_QUESTIONS: Record<string, string[]> = Object.fromEntries(
  DEPARTMENTS.map((d) => [d.key, d.questions.map((q) => q.q)])
);

/** Detect the person named in "X is the only one who..." style observations. */
export function sniffPerson(text: string): { name: string; carries: string } | null {
  const m = text.match(
    /([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:is the only|is our only|holds|knows|handles all|runs all|does all|keeps)/
  );
  if (!m) return null;
  return { name: m[1], carries: text.slice(0, 160) };
}

/** Detect a named software system in the observation. */
export const KNOWN_SYSTEMS: [RegExp, string, string][] = [
  [/servicetrade/i, 'ServiceTrade', 'field-service'],
  [/inspect ?point/i, 'Inspect Point', 'field-service'],
  [/buildops/i, 'BuildOps', 'field-service'],
  [/quickbooks/i, 'QuickBooks', 'accounting'],
  [/sage|viewpoint|foundation/i, 'Accounting package', 'accounting'],
  [/\bteams\b|microsoft ?365|m365|outlook/i, 'Microsoft 365 / Teams', 'comms'],
  [/excel|spreadsheet|google sheet/i, 'Spreadsheets', 'spreadsheet'],
  [/whatsapp|group (chat|text)|text thread/i, 'Group chats', 'comms'],
];

function severityFromText(text: string): string {
  if (/every (day|week|single)|always|constantly|\$\d{2,}k|month|weeks?\b/i.test(text)) return 'high';
  if (/sometimes|occasionally|once in/i.test(text)) return 'low';
  return 'medium';
}

/** The keyless operator: rules-engine classification, matching, and questioning. */
/**
 * Name a custom (off-catalog) agent from the gap it fixes. Keyless and deterministic: take
 * the meaningful words of the finding, title-case two or three of them, and append "Agent"
 * (e.g. "Deficiency findings are managed informally" -> "Deficiency Findings Agent"). The
 * harness sharpens this with an LLM when a key is present; this is the honest keyless name.
 */
const NAME_STOPWORDS = new Set([
  'the','a','an','and','or','but','of','to','in','on','for','by','with','is','are','not','no','be','been',
  'that','this','it','its','as','at','from','into','out','up','down','our','their','have','has','we','they',
  'go','goes','going','get','gets','yet','still','just','than','then','so','do','does','done','each','every',
]);
export function customAgentName(title: string, pillarKey?: string | null): string {
  const words = String(title || '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
  const core = words.slice(0, 3).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  if (!core.length) {
    const p = pillarKey ? pillarByKey(pillarKey)?.name || pillarKey : 'Operations';
    return `${p} Agent`;
  }
  return `${core.join(' ')} Agent`;
}

function rulesAnalysis(text: string, department?: string): Analysis {
  const pillars = PILLAR_HINTS.filter(([, re]) => re.test(text)).map(([k]) => k);
  // an active department deep-dive anchors the classification
  if (department && pillarByKey(department)) {
    const i = pillars.indexOf(department);
    if (i > 0) pillars.splice(i, 1);
    if (i !== 0) pillars.unshift(department);
  }
  if (!pillars.length) pillars.push('ops');
  const top = pillars.slice(0, 3);

  // capability matching off catalog triggers, preferring builds that belong to the
  // anchored/top pillar (so a growth observation surfaces a growth build, not an
  // operational one that happens to share a trigger word like "recurring" or "permit").
  const matched = CAPABILITIES.filter((c) => c.triggers.some((t) => new RegExp(t, 'i').test(text)));
  const pillarScore = (c: { pillars: string[] }) =>
    c.pillars.includes(top[0]) ? 2 : c.pillars.some((p) => top.includes(p)) ? 1 : 0;
  matched.sort((a, b) => pillarScore(b) - pillarScore(a));
  const caps = matched.slice(0, 3).map((c) => ({
    id: c.id,
    pitch: `${c.what}${c.live ? ' — already running in this OS.' : ''}`,
  }));

  // entities
  const person = sniffPerson(text);
  const systems = KNOWN_SYSTEMS.filter(([re]) => re.test(text)).map(([, name, category]) => ({
    name,
    category,
    pillar: top[0],
  }));

  // a finding grounded in their words
  const sev = severityFromText(text);
  const findings = [
    {
      pillar: top[0],
      kind: person ? 'risk' : 'leak',
      title: text.length > 90 ? text.slice(0, 87) + '…' : text,
      detail: caps.length
        ? `Operator read: this is a ${person ? 'single-point-of-failure risk' : 'process leak'} on ${
            pillarByKey(top[0])?.name || top[0]
          }. Matched build: ${capabilityById(caps[0].id)?.name}.`
        : `Logged against ${pillarByKey(top[0])?.name || top[0]} for the leak table.`,
      severity: person ? 'high' : sev,
      cost_hint: '',
    },
  ];

  // questions: pull from the matched pillars
  const questions: string[] = [];
  for (const p of top) {
    for (const q of PILLAR_QUESTIONS[p] || []) {
      if (questions.length < 3 && !questions.includes(q)) questions.push(q);
    }
  }

  return {
    pillars: top,
    systems,
    people: person ? [{ name: person.name, carries: person.carries, risk: 'high', pillar: top[0] }] : [],
    workflows: [],
    findings,
    capabilities: caps,
    questions,
    engine: 'operator-rules',
  };
}

/* ─────────────────────── LLM operator brain ─────────────────────── */

function auditContextSummary(): string {
  const db = getDb();
  const counts = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  const recent = db
    .prepare(`SELECT title FROM audit_findings WHERE status='open' ORDER BY id DESC LIMIT 6`)
    .all() as { title: string }[];
  return [
    `Audit so far: ${counts('audit_systems')} systems, ${counts('audit_people')} people, ${counts(
      'audit_workflows'
    )} workflows, ${counts('audit_findings')} findings logged.`,
    recent.length ? `Recent findings: ${recent.map((r) => r.title).join(' | ')}` : '',
    `Company locations: ${COMPANY.locations.join(', ')}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function llmAnalysis(text: string, location?: string, department?: string): Promise<Analysis | null> {
  const result = await chat(
    [
      { role: 'system', content: OPERATOR_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${auditContextSummary()}\n\n${
          location ? `This observation is about the ${location} location.\n` : ''
        }${
          department ? `We are deep-diving the "${department}" department — anchor your read there.\n` : ''
        }OBSERVATION: "${text}"`,
      },
    ],
    { maxTokens: 900 }
  );
  if (!result || !result.text) return null;
  try {
    const parsed = JSON.parse(result.text.replace(/```json|```/g, '').trim());
    const validCaps = (Array.isArray(parsed.capabilities) ? parsed.capabilities : []).filter(
      (c: any) => c && capabilityById(String(c.id))
    );
    return {
      pillars: (Array.isArray(parsed.pillars) ? parsed.pillars : []).filter((p: any) => pillarByKey(String(p))),
      systems: Array.isArray(parsed.systems) ? parsed.systems : [],
      people: Array.isArray(parsed.people) ? parsed.people : [],
      workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      capabilities: validCaps.map((c: any) => ({ id: String(c.id), pitch: String(c.pitch || '') })),
      questions: (Array.isArray(parsed.questions) ? parsed.questions : []).map(String).slice(0, 3),
      engine: 'operator-llm',
    };
  } catch {
    return null; // malformed JSON → the rules engine takes over
  }
}

/* ─────────────────────── capture + persist ─────────────────────── */

/** Persist follow-up questions one depth level down, deduped per pillar. Returns how many were new. */
function persistFollowups(questions: string[], pillar: string, depth: number): number {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO audit_questions (question, pillar_key, depth_level, status) VALUES (?, ?, ?, 'open')`
  );
  let inserted = 0;
  for (const q of questions) {
    if (!q || !q.trim()) continue;
    const dup = db
      .prepare(`SELECT id FROM audit_questions WHERE lower(question) = lower(?) AND pillar_key = ?`)
      .get(q, pillar);
    if (!dup) {
      ins.run(q, pillar, depth);
      inserted++;
    }
  }
  return inserted;
}

/** Consultant drill-down lenses — the keyless brain still deepens the interview by
 *  rotating these when it has no LLM to generate a sharper, novel follow-up. */
const DRILL_LENSES = [
  'Put a number on that: how many, how long, or how much per month?',
  'Where exactly does that stall, and who owns the step?',
  'If the person who handles that left tomorrow, what breaks first?',
  'How does that differ from one location to the next today?',
  'What would it be worth to fix that in the next 90 days?',
];

export async function capture(
  text: string,
  location?: string,
  department?: string,
  questionId?: number
): Promise<Analysis & { noteId: number }> {
  const analysis =
    (activeProvider() !== 'none' ? await llmAnalysis(text, location, department) : null) ||
    rulesAnalysis(text, department);

  const db = getDb();
  const noteInfo = db
    .prepare(`INSERT INTO audit_notes (text, location, analysis) VALUES (?, ?, ?)`)
    .run(text, location || null, JSON.stringify(analysis));
  const noteId = Number(noteInfo.lastInsertRowid);

  // persist entities (dedupe by name)
  const sysIns = db.prepare(
    `INSERT INTO audit_systems (name, category, truth_for, gaps, pillar_key) VALUES (?, ?, ?, ?, ?)`
  );
  for (const s of analysis.systems) {
    if (!s?.name) continue;
    const dup = db.prepare(`SELECT id FROM audit_systems WHERE lower(name)=lower(?)`).get(s.name);
    if (!dup) sysIns.run(s.name, s.category || null, s.truth_for || null, s.gaps || null, s.pillar || analysis.pillars[0] || null);
  }
  const pplIns = db.prepare(
    `INSERT INTO audit_people (name, role, location, carries, risk, pillar_key) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const p of analysis.people) {
    if (!p?.name) continue;
    // partial-name dedupe: "Kelsey" must match the existing "Kayla Brooks", not duplicate her
    const dup = db
      .prepare(
        `SELECT id FROM audit_people
         WHERE lower(name) LIKE '%'||lower(?)||'%' OR lower(?) LIKE '%'||lower(name)||'%'`
      )
      .get(p.name, p.name);
    if (!dup) pplIns.run(p.name, p.role || null, location || null, p.carries || null, p.risk || 'medium', p.pillar || analysis.pillars[0] || null);
  }
  const wfIns = db.prepare(
    `INSERT INTO audit_workflows (name, trigger_desc, stalls, pillar_key) VALUES (?, ?, ?, ?)`
  );
  for (const w of analysis.workflows) {
    if (!w?.name) continue;
    const dup = db.prepare(`SELECT id FROM audit_workflows WHERE lower(name)=lower(?)`).get(w.name);
    if (!dup) wfIns.run(w.name, w.trigger || null, w.stalls || null, w.pillar || analysis.pillars[0] || null);
  }
  const fIns = db.prepare(
    `INSERT INTO audit_findings (pillar_key, kind, title, detail, severity, cost_hint, capability_id, source_note_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  analysis.findings.forEach((f, i) => {
    if (!f?.title) return;
    // attach the strongest capability match to the first finding
    const cap = i === 0 && analysis.capabilities.length ? analysis.capabilities[0].id : null;
    fIns.run(
      f.pillar || analysis.pillars[0] || null,
      f.kind || 'leak',
      f.title,
      f.detail || null,
      f.severity || 'medium',
      f.cost_hint || null,
      cap,
      noteId
    );
  });

  // mark the location as touched
  if (location) db.prepare(`UPDATE audit_locations SET mapped = 1 WHERE name = ?`).run(location);

  // ── deepen the interview ladder ──
  // If this answered a specific question, close it and record the answer.
  let answeredDepth = 0;
  if (questionId) {
    const qrow = db.prepare(`SELECT depth_level FROM audit_questions WHERE id = ?`).get(questionId) as
      | { depth_level: number }
      | undefined;
    if (qrow) {
      db.prepare(
        `UPDATE audit_questions SET status = 'answered', answer = ?, source_note_id = ?, answered_at = datetime('now') WHERE id = ?`
      ).run(text, noteId, questionId);
      answeredDepth = qrow.depth_level;
    }
  }
  // Persist the operator's sharper follow-ups one level deeper (durable, resumable).
  const followPillar = analysis.pillars[0] || department || 'ops';
  const newQs = persistFollowups(analysis.questions, followPillar, answeredDepth + 1);
  // If this answered a question and the brain produced no genuinely new follow-up
  // (the keyless rules engine recycles the deck), synthesize a deeper consultant
  // probe so the ladder still advances one level.
  if (questionId && newQs === 0) {
    persistFollowups([DRILL_LENSES[answeredDepth % DRILL_LENSES.length]], followPillar, answeredDepth + 1);
  }

  // ── write into the hull's shared memory so EVERY agent gets smarter ──
  try {
    const pillarName = pillarByKey(followPillar)?.name || followPillar;
    await rememberFact(COMPANY.name, `operator noted (${pillarName})`, text.slice(0, 220), 0.6);
    rememberEpisode('operator', `Audit: ${analysis.findings[0]?.title || text.slice(0, 80)}`, text, 0.6);
  } catch {
    /* memory is best-effort; never block the capture */
  }

  // ── associative memory: the entities named together in ONE observation genuinely
  // co-occur, so reinforce their pairwise associations (real co-activation, not invented). ──
  try {
    const at = new Date().toISOString();
    const nodeIds: number[] = [];
    const pillarName = pillarByKey(followPillar)?.name || followPillar;
    nodeIds.push(upsertNode(pillarName, 'pillar'));
    for (const s of analysis.systems) if (s?.name) nodeIds.push(upsertNode(s.name, 'system'));
    for (const p of analysis.people) if (p?.name) nodeIds.push(upsertNode(p.name, 'person'));
    const firstFinding = analysis.findings[0]?.title;
    if (firstFinding) nodeIds.push(upsertNode(firstFinding, 'finding'));
    reinforceCoActivation(nodeIds, at);
  } catch {
    /* association is a recall aid; never block the capture */
  }

  // ── daily "getting smarter" log ──
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO audit_days (day, facts_learned, coverage_pct) VALUES (?, 1, 0)
     ON CONFLICT(day) DO UPDATE SET facts_learned = facts_learned + 1`
  ).run(today);

  return { ...analysis, noteId };
}

/** Approve a proposed build: the human gate that turns a gap into a work order. This is also
 *  the moment the Operator has STAKED something, so it auto-logs one open prediction from the
 *  finding into the calibration ledger. `at` is the request-handler timestamp (no argless clock). */
export function approveGap(id: number, at?: string): { ok: boolean } {
  const now = at || new Date().toISOString();
  getDb().prepare(`UPDATE audit_findings SET queue_status = 'approved', status = 'building' WHERE id = ?`).run(id);
  try {
    createPredictionForFinding(id, now);
  } catch {
    /* the prediction is a ledger entry; never fail the approval on it */
  }
  return { ok: true };
}

/* ─────────────────────── state rollup ─────────────────────── */

export function auditState() {
  const db = getDb();
  const systems = db.prepare(`SELECT * FROM audit_systems ORDER BY id DESC`).all() as any[];
  const people = db.prepare(`SELECT * FROM audit_people ORDER BY CASE risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id DESC`).all() as any[];
  const workflows = db.prepare(`SELECT * FROM audit_workflows ORDER BY id DESC`).all() as any[];
  const findings = db
    .prepare(`SELECT * FROM audit_findings WHERE status != 'dismissed' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id DESC`)
    .all() as any[];
  const notes = db.prepare(`SELECT id, text, location, created_at FROM audit_notes ORDER BY id DESC LIMIT 12`).all();
  const locations = db.prepare(`SELECT * FROM audit_locations ORDER BY id`).all() as any[];
  const questions = db
    .prepare(`SELECT id, question, pillar_key, depth_level, status FROM audit_questions`)
    .all() as any[];

  const pillars = PILLARS.map((p) => {
    const sys = systems.filter((s) => s.pillar_key === p.key).length;
    const ppl = people.filter((s) => s.pillar_key === p.key).length;
    const wf = workflows.filter((s) => s.pillar_key === p.key).length;
    const fnd = findings.filter((s) => s.pillar_key === p.key);
    const capIds = Array.from(new Set(fnd.map((f) => f.capability_id).filter(Boolean))) as string[];
    const answered = questions.filter((q) => q.pillar_key === p.key && q.status === 'answered').length;
    const openQuestions = questions
      .filter((q) => q.pillar_key === p.key && q.status === 'open')
      .sort((a, b) => a.depth_level - b.depth_level || a.id - b.id)
      .slice(0, 8)
      .map((q) => ({ id: q.id, question: q.question, depth: q.depth_level }));
    // coverage: how mapped is this pillar (entities + evidence + interview depth, capped)
    const coverage = Math.min(100, sys * 18 + ppl * 15 + wf * 22 + fnd.length * 12 + answered * 8);
    return {
      ...p,
      counts: { systems: sys, people: ppl, workflows: wf, findings: fnd.length },
      coverage,
      answered,
      openQuestions,
      capabilities: capIds.map((id) => {
        const c = capabilityById(id)!;
        return { id, name: c.name, live: !!c.live };
      }),
    };
  });

  // ── the gap feed / build queue: matched findings are proposed builds ──
  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  // Matched findings propose a catalog build. UNMATCHED leaks (no capability) are not
  // dropped: the Operator proposes a CUSTOM agent for them, so the team can grow in
  // directions the catalog does not list yet. Strengths are not builds.
  const gapFeed = findings
    .filter((f) => f.kind !== 'strength' && (capabilityById(f.capability_id) || f.kind === 'gap' || f.kind === 'leak' || f.kind === 'risk'))
    .map((f) => {
      const c = f.capability_id ? capabilityById(f.capability_id) : undefined;
      if (c) {
        return {
          id: f.id,
          pillar_key: f.pillar_key,
          pillar: pillarByKey(f.pillar_key)?.name || f.pillar_key,
          title: f.title,
          detail: f.detail,
          severity: f.severity,
          build: c.name,
          build_id: c.id,
          build_type: c.live ? 'UPGRADE' : 'NEW',
          custom: false,
          value: f.value_line || f.cost_hint || '',
          queue_status: f.queue_status || 'proposed',
        };
      }
      return {
        id: f.id,
        pillar_key: f.pillar_key,
        pillar: pillarByKey(f.pillar_key)?.name || f.pillar_key,
        title: f.title,
        detail: f.detail,
        severity: f.severity,
        build: customAgentName(f.title, f.pillar_key),
        build_id: null,
        build_type: 'NEW',
        custom: true, // off-catalog: the Operator invented this agent for a gap the catalog misses
        value: f.value_line || f.cost_hint || '',
        queue_status: f.queue_status || 'proposed',
      };
    })
    .sort((a, b) => {
      const qa = a.queue_status === 'proposed' ? 0 : 1;
      const qb = b.queue_status === 'proposed' ? 0 : 1;
      return qa - qb || (sevRank[a.severity] ?? 2) - (sevRank[b.severity] ?? 2);
    });

  const days = db.prepare(`SELECT day, facts_learned, coverage_pct FROM audit_days ORDER BY day`).all() as any[];
  const questionsAnswered = questions.filter((q) => q.status === 'answered').length;
  const buildsApproved = findings.filter((f) => ['approved', 'building', 'shipped'].includes(f.queue_status)).length;

  const mappedLocations = locations.filter((l) => l.mapped).length;
  const openLeaks = findings.filter((f) => f.kind !== 'strength').length;
  const matchedBuilds = new Set(findings.map((f) => f.capability_id).filter(Boolean)).size;
  const coverageAvg = Math.round(pillars.reduce((a, p) => a + p.coverage, 0) / pillars.length);

  // keep today's "getting smarter" trend point current with live coverage
  const todayKey = new Date().toISOString().slice(0, 10);
  db.prepare(`UPDATE audit_days SET coverage_pct = ? WHERE day = ?`).run(coverageAvg, todayKey);

  // the self-knowing brain: how well it knows (calibration) + what it remembers goes
  // together (associations). Both computed on read; nothing scheduled.
  const calib = calibration();
  const associations = topAssociations(8);

  return {
    brain: activeProvider() !== 'none',
    company: { name: COMPANY.name, locations: COMPANY.locations },
    metrics: {
      coverage: coverageAvg,
      leaks: openLeaks,
      builds: matchedBuilds,
      veterans: people.filter((p) => p.risk === 'high').length,
      locationsMapped: mappedLocations,
      locationsTotal: locations.length,
      questionsAnswered,
      buildsApproved,
      predictionsOpen: calib.counts.open,
      predictionsResolved: calib.counts.resolved,
    },
    calibration: calib,
    associations,
    gapFeed,
    days,
    pillars,
    locations,
    systems,
    people,
    workflows,
    findings: findings.map((f) => ({
      ...f,
      capability: f.capability_id ? capabilityById(f.capability_id)?.name : null,
      capability_live: f.capability_id ? !!capabilityById(f.capability_id)?.live : false,
    })),
    notes,
    catalog: CAPABILITIES.map((c) => ({ id: c.id, name: c.name, what: c.what, live: !!c.live })),
    departments: DEPARTMENTS.map((d) => ({
      ...d,
      agents: d.agents.map((a) => ({
        ...a,
        live: a.live || (a.capability_id ? !!capabilityById(a.capability_id)?.live : false),
      })),
    })),
  };
}

/* ─────────────────────── executive brief ─────────────────────── */

/** Assemble the executive brief from live audit data. Template always works; LLM polishes. */
export async function generateBrief(): Promise<{ markdown: string; engine: string }> {
  const s = auditState();
  const sev = (x: string) => ({ critical: '🔴', high: '🔴', medium: '🟡', low: '⚪' }[x] || '🟡');

  const lines: string[] = [
    `# ${s.company.name} — Operational Audit Brief`,
    ``,
    `**Coverage:** ${s.metrics.coverage}% of the operation mapped · **${s.metrics.leaks} leaks found** · **${s.metrics.builds} AI builds matched** · ${s.metrics.locationsMapped}/${s.metrics.locationsTotal} locations touched`,
    ``,
    `## The Leak Table`,
    ``,
  ];
  for (const f of s.findings.filter((f: any) => f.kind !== 'strength').slice(0, 12)) {
    const pillar = pillarByKey(f.pillar_key)?.name || f.pillar_key || '—';
    lines.push(
      `- ${sev(f.severity)} **${f.title}** _(${pillar})_${f.detail ? ` — ${f.detail}` : ''}${
        f.capability ? `\n  → **We build:** ${f.capability}${f.capability_live ? ' *(already live in this OS)*' : ''}` : ''
      }`
    );
  }
  const vets = s.people.filter((p: any) => p.risk !== 'low');
  if (vets.length) {
    lines.push(``, `## Single Points of Failure`, ``);
    for (const p of vets)
      lines.push(`- **${p.name}**${p.role ? ` (${p.role})` : ''} — ${p.carries || 'holds critical tribal knowledge'} · risk: ${p.risk}`);
  }
  if (s.systems.length) {
    lines.push(``, `## Systems of Record`, ``);
    for (const sys of s.systems)
      lines.push(`- **${sys.name}**${sys.category ? ` (${sys.category})` : ''}${sys.gaps ? ` — gap: ${sys.gaps}` : ''}`);
  }
  lines.push(
    ``,
    `## Build Order`,
    ``,
    `Ranked by leak severity — each build lands on the same OS, sharing one brain:`,
    ``
  );
  const seen = new Set<string>();
  let rank = 1;
  for (const f of s.findings) {
    if (!f.capability_id || seen.has(f.capability_id)) continue;
    seen.add(f.capability_id);
    const c = capabilityById(f.capability_id)!;
    lines.push(`${rank}. **${c.name}**${c.live ? ' — *already running*' : ''} — ${c.builds}`);
    rank++;
  }
  lines.push(``, `---`, `*Generated live by The Operator inside the ${s.company.name} OS.*`);
  const template = lines.join('\n');

  // LLM polish (optional — the template is the guarantee)
  if (activeProvider() !== 'none') {
    const polished = await chat(
      [
        {
          role: 'system',
          content: `You are an enterprise operations consultant finalizing an executive brief for the CEO of ${s.company.name} (fire protection, Central & South Texas). Tighten the language, keep ALL data and structure, keep it markdown, keep it under 500 words. Authoritative, specific, zero fluff.`,
        },
        { role: 'user', content: template },
      ],
      { maxTokens: 1200 }
    );
    if (polished?.text) return { markdown: polished.text, engine: 'operator-llm' };
  }
  return { markdown: template, engine: 'operator-rules' };
}
