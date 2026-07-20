import { getDb } from '../db/index';
import { chat } from './llm';
import { activeProvider, MODELS } from '../config/models';
import { COMPANY } from '../config/constants';
import { deptByKey } from '../config/departments';
import { CAPABILITIES, capabilityById } from '../config/capabilities';
import { knowledgeContext, LEAK_ARCHETYPES } from '../config/knowledge';
import { sniffPerson, KNOWN_SYSTEMS } from './auditAgent';

/**
 * THE CONSULT LOOP (prefrontal cortex) — the live-meeting brain.
 *
 * The founder relays the CEO's last answer; this returns, fast:
 *   reaction        — half a line proving it heard ("that's the classic single point of failure")
 *   next_question   — generated FROM the answer, sharp, operator-grade. QUESTIONS, NEVER CLAIMS.
 *   suggested_chips — 2–3 most common operator answers (the founder's safety net, never a cage)
 *   spawn_node      — the agent-capability node this answer just earned on the map, or null
 *
 * One LLM call (Sonnet — this runs live; latency kills the room). Strict-JSON output,
 * extracted defensively (first '{' → last '}'), never raw-parsed. Keyless fallback: the
 * archetype rules engine still reacts, asks, and spawns so a demo without keys holds up.
 */

export interface SpawnNode {
  name: string;
  caption: string;
  connects_to: string[];
  capability_id?: string;
}

export interface ConsultTurn {
  reaction: string;
  question: string;
  chips: string[];
  node: SpawnNode | null;
  engine: 'consult-llm' | 'consult-rules';
}

/* ───────────── rules fallback: archetype recognition ───────────── */

/** capability id → (reaction template, archetype probe). Voice: operator, zero claims. */
const CAP_REACTIONS: Record<string, { reaction: string; probe: string }> = {
  quote_drafter: { reaction: 'That lag is the expensive part — quotes cool off fast.', probe: 'When a deficiency is found on a Tuesday, what date does the customer actually see a price?' },
  deficiency_pipeline: { reaction: 'So findings live on memory and goodwill — heard that in a lot of shops.', probe: 'Of ten deficiencies your techs write up, how many become paid repairs — and who counts?' },
  knowledge_capture: { reaction: 'That\'s the classic single point of failure.', probe: 'If that person took two weeks off with no phone, what breaks on day three?' },
  exec_dashboard: { reaction: 'So the decision is older than the data should be.', probe: 'What number do you wish you saw every morning that you currently see monthly?' },
  data_bridge: { reaction: 'Every one of those re-keys is a quiet leak.', probe: 'How many times does one completed job get typed into something by a human?' },
  location_command: { reaction: 'Nine sites, nine versions of the truth — that\'s the pattern.', probe: 'Which branch runs it best — and would the other branch managers agree?' },
  renewal_guardian: { reaction: 'Silent lapses are pure recurring revenue walking out the door.', probe: 'Who gets told when an inspection agreement quietly doesn\'t renew — anyone?' },
  emergency_triage: { reaction: 'The 2am call is where reputations are made or lost.', probe: 'Walk me through last month\'s worst after-hours call — what actually happened, minute by minute?' },
  invoice_chaser: { reaction: 'Relationship-first companies hate chasing money — so nobody does.', probe: 'What\'s the oldest invoice out there right now, roughly — and who\'s supposed to be on it?' },
  ai_receptionist: { reaction: 'The front line is where leads quietly die.', probe: 'Of the calls that come in while everyone\'s in the field — where do those actually end up?' },
  dispatch_optimizer: { reaction: 'Windshield time is the invisible payroll line.', probe: 'How many billable hours per tech per day — and does anyone actually see that number?' },
  compliance_watchdog: { reaction: 'AHJ quirks living in one head — that\'s the risk I\'d flag first.', probe: 'If a permit deadline hits in a county he doesn\'t cover often — does it stall, or does someone catch it?' },
  bid_intel: { reaction: 'Inconsistent pricing bleeds margin quietly.', probe: 'Do two estimators price the same job the same way — have you ever tested it?' },
  onboarding_brain: { reaction: 'Ramp time is the hidden cost of every hire.', probe: 'What could a new tech NOT figure out alone in the truck today?' },
  review_engine: { reaction: 'Word of mouth built this company — but it\'s not systematized.', probe: 'After a great job, does anything actually ask the customer to say so publicly?' },
};

const GENERIC_CHIPS = ['One person owns it', 'Depends on the day', 'We don\'t really track it'];

function rulesConsult(department: string, answer: string): Omit<ConsultTurn, 'engine'> {
  const dept = deptByKey(department);
  // capability trigger match on their words
  let matched: string | null = null;
  for (const c of CAPABILITIES) {
    if (c.triggers.some((t) => new RegExp(t, 'i').test(answer))) { matched = c.id; break; }
  }
  const person = sniffPerson(answer);
  if (!matched && person) matched = 'knowledge_capture';

  const db = getDb();
  const spawned = new Set(
    (db.prepare(`SELECT name FROM audit_nodes WHERE pillar_key = ?`).all(department) as { name: string }[]).map((r) => r.name)
  );

  // spawn: the dept agent carrying the matched capability, else the next unborn agent
  let node: SpawnNode | null = null;
  const agents = dept?.agents || [];
  const byCap = matched ? agents.find((a) => a.capability_id === matched && !spawned.has(a.name)) : undefined;
  const next = byCap || agents.find((a) => !spawned.has(a.name));
  if (next) {
    node = {
      name: next.name,
      caption: next.what,
      connects_to: (dept?.systems || []).slice(0, 2).concat(person ? [person.name] : []),
      capability_id: next.capability_id,
    };
  } else if (matched && !spawned.has(capabilityById(matched)!.name)) {
    const c = capabilityById(matched)!;
    node = { name: c.name, caption: c.what, connects_to: (dept?.systems || []).slice(0, 2), capability_id: c.id };
  }

  const r = matched ? CAP_REACTIONS[matched] : undefined;
  const reaction = person && !r
    ? 'That\'s the classic single point of failure.'
    : r?.reaction || 'Noted — that\'s going on the map.';
  // next question: archetype probe → else an unasked deck question → else a generic lens
  const askedProbe = r?.probe;
  let question = askedProbe || '';
  if (!question && dept) {
    question = dept.questions.map((q) => q.q).find((q) => true) ||
      'Where does this department stall most — and who feels it first?';
  }
  if (!question) question = 'Where does this department stall most — and who feels it first?';
  const chips = (dept?.questions.find((q) => q.q === question)?.chips) || GENERIC_CHIPS;
  return { reaction, question, chips, node };
}

/* ───────────── the LLM consult (one Sonnet call) ───────────── */

function sessionContext(department: string): string {
  const db = getDb();
  const notes = db
    .prepare(`SELECT text FROM audit_notes ORDER BY id DESC LIMIT 8`)
    .all() as { text: string }[];
  const nodes = db
    .prepare(`SELECT name FROM audit_nodes WHERE pillar_key = ?`)
    .all(department) as { name: string }[];
  const people = db.prepare(`SELECT name, carries FROM audit_people ORDER BY id DESC LIMIT 6`).all() as any[];
  return [
    notes.length ? `MAPPED SO FAR THIS SESSION (most recent first):\n${notes.map((n) => `- ${n.text}`).join('\n')}` : 'Session just started — nothing mapped yet.',
    nodes.length ? `AGENT NODES ALREADY ON THIS DEPARTMENT'S MAP (never re-spawn these): ${nodes.map((n) => n.name).join(', ')}` : '',
    people.length ? `PEOPLE ALREADY MAPPED: ${people.map((p) => p.name).join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
}

function consultSystemPrompt(department: string): string {
  const dept = deptByKey(department);
  const agentList = (dept?.agents || [])
    .map((a) => `- "${a.name}" (capability_id: ${a.capability_id || 'custom'}): ${a.what}`)
    .join('\n');
  return `
You are the operator brain inside ${COMPANY.name}'s audit instrument, live in an enterprise
sales meeting. A founder (NOT a business expert) is consulting the CEO of a fire-protection
company. The CEO talks to the founder; the founder glances at your output and delivers it in
their own voice. You are the thinking; the founder is the voice. Latency and brevity matter —
everything you return will be read in under one second, mid-conversation.

CURRENT DEPARTMENT: ${dept?.name || department} — ${dept?.tagline || ''}
Its buildable agents (spawn from these when the answer earns one; invent a new one only when
none fits):
${agentList}
Systems this department typically touches: ${(dept?.systems || []).join(', ')}

${knowledgeContext(department)}

═══ HOW YOU BEHAVE ═══
1. REACT BEFORE ASKING. Half a line that proves you heard THEIR last answer ("yeah — that's
   the classic single-point-of-failure"). Specific to what they said, never generic filler.
2. THE NEXT QUESTION IS BORN FROM THEIR LAST ANSWER — not a deck. It should feel like a
   20-year operator following the thread: name the person/step they mentioned, chase the
   stall, quantify ("how many / how long / who").
3. QUESTIONS, NEVER CLAIMS. Never assert a number or fact about THEIR business ("your permit
   turnaround is ~9 days" is forbidden). A question can't be wrong; a wrong claim ends the
   meeting. Benchmarks may be used INSIDE a question ("shops that quote inside 24h convert
   2–3× — where do yours usually land?").
4. Chips are the 2–3 most common answers a real operator would give — short (2–6 words),
   plain, so the founder can tap one if the CEO's answer matches.
5. spawn_node: when the answer reveals a pain an agent solves, spawn it — prefer this
   department's listed agents (use their exact name + capability_id). caption = one plain
   line tying it to what the CEO just said (their words, not tech-speak). connects_to = the
   real systems/people from their answer. null when nothing new was earned. Never re-spawn.

═══ OUTPUT ═══
ONLY a JSON object, no fences, exactly:
{"reaction":"...","next_question":"...","suggested_chips":["...","..."],
 "spawn_node":{"name":"...","caption":"...","connects_to":["..."],"capability_id":"..."} | null,
 "finding":{"title":"...","detail":"...","severity":"low|medium|high"} | null}
finding = the leak/risk this answer exposed, in their words, for the leak table (null if none).
`.trim();
}

/** Defensive JSON extraction: first '{' to last '}', never raw-parse model output. */
function extractJson(text: string): any | null {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

async function llmConsult(
  department: string,
  answer: string,
  question?: string,
  location?: string
): Promise<Omit<ConsultTurn, 'engine'> | null> {
  const result = await chat(
    [
      { role: 'system', content: consultSystemPrompt(department) },
      {
        role: 'user',
        content: `${sessionContext(department)}\n\n${location ? `This exchange is about the ${location} location.\n` : ''}${
          question ? `THE FOUNDER JUST ASKED: "${question}"\n` : ''
        }THE CEO ANSWERED: "${answer}"`,
      },
    ],
    { maxTokens: 500, model: activeProvider() === 'anthropic' ? MODELS.anthropic.consult : undefined }
  );
  if (!result?.text) return null;
  const j = extractJson(result.text);
  if (!j || typeof j.next_question !== 'string') return null;

  let node: SpawnNode | null = null;
  if (j.spawn_node && typeof j.spawn_node.name === 'string') {
    node = {
      name: String(j.spawn_node.name).slice(0, 40),
      caption: String(j.spawn_node.caption || '').slice(0, 140),
      connects_to: Array.isArray(j.spawn_node.connects_to) ? j.spawn_node.connects_to.map(String).slice(0, 4) : [],
      capability_id: j.spawn_node.capability_id ? String(j.spawn_node.capability_id) : undefined,
    };
  }
  return {
    reaction: String(j.reaction || '').slice(0, 160),
    question: String(j.next_question).slice(0, 240),
    chips: Array.isArray(j.suggested_chips) ? j.suggested_chips.map(String).slice(0, 3) : [],
    node,
    // stash the finding for persistence
    ...( { _finding: j.finding } as any ),
  };
}

/* ───────────── the loop: think → persist → return ───────────── */

export async function consult(opts: {
  department: string;
  answer: string;
  question?: string;
  location?: string;
}): Promise<ConsultTurn> {
  const { department, answer, question, location } = opts;
  const llm = activeProvider() !== 'none' ? await llmConsult(department, answer, question, location) : null;
  const turn = llm || rulesConsult(department, answer);
  const engine: ConsultTurn['engine'] = llm ? 'consult-llm' : 'consult-rules';

  const db = getDb();
  const noteText = question ? `${question} — ${answer}` : answer;
  db.prepare(`INSERT INTO audit_notes (text, location, analysis) VALUES (?, ?, ?)`).run(
    noteText, location || null, JSON.stringify({ engine, reaction: turn.reaction, node: turn.node })
  );

  // entities from their words (cheap, deterministic)
  const person = sniffPerson(answer);
  if (person) {
    const dup = db.prepare(
      `SELECT id FROM audit_people WHERE lower(name) LIKE '%'||lower(?)||'%' OR lower(?) LIKE '%'||lower(name)||'%'`
    ).get(person.name, person.name);
    if (!dup) db.prepare(
      `INSERT INTO audit_people (name, carries, risk, pillar_key, location) VALUES (?, ?, 'high', ?, ?)`
    ).run(person.name, person.carries, department, location || null);
  }
  for (const [re, name, category] of KNOWN_SYSTEMS) {
    if (re.test(answer)) {
      const dup = db.prepare(`SELECT id FROM audit_systems WHERE lower(name)=lower(?)`).get(name);
      if (!dup) db.prepare(`INSERT INTO audit_systems (name, category, pillar_key) VALUES (?, ?, ?)`).run(name, category, department);
    }
  }

  // the finding (LLM-provided, else rules-derived when a capability matched)
  const f = (turn as any)._finding;
  if (f && typeof f.title === 'string' && f.title) {
    db.prepare(
      `INSERT INTO audit_findings (pillar_key, kind, title, detail, severity, capability_id) VALUES (?, 'leak', ?, ?, ?, ?)`
    ).run(department, String(f.title).slice(0, 140), String(f.detail || '').slice(0, 240),
      ['low', 'medium', 'high'].includes(f.severity) ? f.severity : 'medium', turn.node?.capability_id || null);
  } else if (!llm && turn.node?.capability_id) {
    db.prepare(
      `INSERT INTO audit_findings (pillar_key, kind, title, detail, severity, capability_id) VALUES (?, 'leak', ?, ?, 'medium', ?)`
    ).run(department, noteText.slice(0, 140), `Matched build: ${turn.node.name}.`, turn.node.capability_id);
  }

  // the node birth — persisted so the map re-renders born next session
  if (turn.node) {
    db.prepare(
      `INSERT OR IGNORE INTO audit_nodes (pillar_key, name, caption, connects, capability_id) VALUES (?, ?, ?, ?, ?)`
    ).run(department, turn.node.name, turn.node.caption, JSON.stringify(turn.node.connects_to), turn.node.capability_id || null);
  }

  if (location) db.prepare(`UPDATE audit_locations SET mapped = 1 WHERE name = ?`).run(location);

  delete (turn as any)._finding;
  return { ...turn, engine };
}
