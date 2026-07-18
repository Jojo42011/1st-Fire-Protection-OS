import { getDb } from '../db/index';
import { chat } from './llm';
import { activeProvider } from '../config/models';
import { OPERATOR_SYSTEM_PROMPT, PILLARS, pillarByKey } from '../config/auditor';
import { CAPABILITIES, capabilityById } from '../config/capabilities';
import { COMPANY } from '../config/constants';

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
  ['inspections', /inspect|itm|nfpa|annual|quarterly|tag|test(ing)?|backflow|hydro/i],
  ['service', /repair|service call|emergency|leak|break|fix|deficien|alarm going/i],
  ['sales', /quote|estimat|bid|proposal|sales|install|price|margin|win/i],
  ['dispatch', /dispatch|schedul|route|tech(nician)?s?\b|truck|calendar|book/i],
  ['compliance', /ahj|code|permit|jurisdiction|marshal|compliance|citation|violation/i],
  ['finance', /invoice|receivab|collect|owe|pay|billing|cash|dso|aging|quickbooks|account/i],
  ['people', /retir|in his head|in her head|only one|tribal|train|hire|onboard|veteran|knows every/i],
  ['growth', /review|reputation|referral|marketing|location|branch|expand|growth/i],
];

/** Sharp, quantified follow-ups per pillar — what a veteran operator asks next. */
const PILLAR_QUESTIONS: Record<string, string[]> = {
  inspections: [
    'How many inspection agreements are active, and who watches for ones that quietly lapse?',
    'When a deficiency is found on site, how many days until a quote is in the customer\'s inbox?',
  ],
  service: [
    'What percentage of deficiencies found actually convert to paid repair work? (Systematic shops hit 30–50%.)',
    'What happens to an after-hours emergency call today, step by step?',
  ],
  sales: [
    'How long does a repair quote sit before it goes out — and who is it waiting on?',
    'What\'s your win rate when the quote goes out inside 24 hours versus a week?',
  ],
  dispatch: [
    'Who builds the schedule, and what breaks when that person is out for a week?',
    'How many billable hours per tech per day — and how much is windshield time?',
  ],
  compliance: [
    'Which jurisdictions have quirks that only one person knows how to navigate?',
    'How do you track the different AHJ requirements across your nine cities?',
  ],
  finance: [
    'What\'s the total outstanding right now — and how long would it take you to get that number?',
    'How many days from job-complete to invoice-sent? (Manual invoicing adds 15–30 days of DSO.)',
  ],
  people: [
    'If that person left tomorrow, what breaks first — and who else can do it today?',
    'What\'s written down versus what walks out the door at 5pm?',
  ],
  growth: [
    'Which location runs best, which is the problem child — and does anyone see them side by side?',
    'After a job completes, does anything systematically ask the customer for a review?',
  ],
};

/** Detect the person named in "X is the only one who..." style observations. */
function sniffPerson(text: string): { name: string; carries: string } | null {
  const m = text.match(
    /([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:is the only|is our only|holds|knows|handles all|runs all|does all|keeps)/
  );
  if (!m) return null;
  return { name: m[1], carries: text.slice(0, 160) };
}

/** Detect a named software system in the observation. */
const KNOWN_SYSTEMS: [RegExp, string, string][] = [
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
function rulesAnalysis(text: string): Analysis {
  const pillars = PILLAR_HINTS.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (!pillars.length) pillars.push('growth');
  const top = pillars.slice(0, 3);

  // capability matching off catalog triggers
  const caps: { id: string; pitch: string }[] = [];
  for (const c of CAPABILITIES) {
    if (caps.length >= 3) break;
    if (c.triggers.some((t) => new RegExp(t, 'i').test(text))) {
      caps.push({
        id: c.id,
        pitch: `${c.what}${c.live ? ' — already running in this OS.' : ''}`,
      });
    }
  }

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

async function llmAnalysis(text: string, location?: string): Promise<Analysis | null> {
  const result = await chat(
    [
      { role: 'system', content: OPERATOR_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${auditContextSummary()}\n\n${
          location ? `This observation is about the ${location} location.\n` : ''
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

export async function capture(text: string, location?: string): Promise<Analysis & { noteId: number }> {
  const analysis =
    (activeProvider() !== 'none' ? await llmAnalysis(text, location) : null) || rulesAnalysis(text);

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
    const dup = db.prepare(`SELECT id FROM audit_people WHERE lower(name)=lower(?)`).get(p.name);
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

  return { ...analysis, noteId };
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

  const pillars = PILLARS.map((p) => {
    const sys = systems.filter((s) => s.pillar_key === p.key).length;
    const ppl = people.filter((s) => s.pillar_key === p.key).length;
    const wf = workflows.filter((s) => s.pillar_key === p.key).length;
    const fnd = findings.filter((s) => s.pillar_key === p.key);
    const capIds = Array.from(new Set(fnd.map((f) => f.capability_id).filter(Boolean))) as string[];
    // coverage: how mapped is this pillar (entities + evidence, capped)
    const coverage = Math.min(100, sys * 18 + ppl * 15 + wf * 22 + fnd.length * 12);
    return {
      ...p,
      counts: { systems: sys, people: ppl, workflows: wf, findings: fnd.length },
      coverage,
      capabilities: capIds.map((id) => {
        const c = capabilityById(id)!;
        return { id, name: c.name, live: !!c.live };
      }),
    };
  });

  const mappedLocations = locations.filter((l) => l.mapped).length;
  const openLeaks = findings.filter((f) => f.kind !== 'strength').length;
  const matchedBuilds = new Set(findings.map((f) => f.capability_id).filter(Boolean)).size;
  const coverageAvg = Math.round(pillars.reduce((a, p) => a + p.coverage, 0) / pillars.length);

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
    },
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
