import { Response } from 'express';
import { chat, ChatMessage } from './llm';
import { activeProvider } from '../config/models';
import { COMPANY } from '../config/constants';
import { memoryContext } from '../db/memory';
import { TOOLS, executeTool } from '../brain/tools';
import { getCallMetrics } from './receptionist';
import { getReceivablesSummary } from './invoiceAgent';
import { getReputationSummary } from './reviewAgent';
import { auditState } from './auditAgent';

/**
 * THE OPERATOR — the digital twin of the whole operating system.
 *
 * One chat surface over everything the OS knows: live receivables, reputation,
 * calls/leads, the audit brain's map (coverage, gaps, built agents), and the
 * long-term memory. Speaks like a sharp COO; numbers come only from the live
 * snapshot (never invented); reversible actions run, outbound actions draft.
 *
 * Keyless degradation is useful, not apologetic: the twin still answers money /
 * reputation / call questions straight from the live data.
 */

/* ── the live snapshot: the twin's ground truth, rebuilt per turn ── */

export interface Snapshot {
  lines: string[];
  recv?: ReturnType<typeof getReceivablesSummary>;
  rep?: ReturnType<typeof getReputationSummary>;
  calls?: ReturnType<typeof getCallMetrics>;
  audit?: { coverage: number; leaks: number; builds: number };
}

export function liveSnapshot(): Snapshot {
  const s: Snapshot = { lines: [] };
  const money = (v: number) => '$' + Math.round(v).toLocaleString('en-US');
  try {
    s.recv = getReceivablesSummary();
    s.lines.push(
      `Receivables: ${money(s.recv.totalOutstanding)} outstanding across ${s.recv.count} invoices; ${money(s.recv.collectedThisMonth)} collected this month.`
    );
  } catch { /* graceful */ }
  try {
    s.rep = getReputationSummary();
    s.lines.push(
      `Reputation: ${s.rep.avgRating.toFixed(1)}★ across ${s.rep.totalReviews} reviews (${s.rep.thisMonthDelta >= 0 ? '+' : ''}${s.rep.thisMonthDelta} this month).`
    );
  } catch { /* graceful */ }
  try {
    s.calls = getCallMetrics();
    s.lines.push(
      `Front line: ${s.calls.callsToday} calls today, ${s.calls.leadsCaptured} leads captured, ${s.calls.transferred} routed.`
    );
  } catch { /* graceful */ }
  try {
    const a = auditState() as any;
    if (a?.metrics) {
      s.audit = { coverage: a.metrics.coverage, leaks: a.metrics.leaks, builds: a.metrics.builds };
      s.lines.push(
        `Operation map: ${s.audit.coverage}% mapped, ${s.audit.leaks} open gaps, ${s.audit.builds} AI builds identified.`
      );
    }
  } catch { /* graceful */ }
  return s;
}

const TWIN_SYSTEM = () =>
  `
You are THE OPERATOR — the standing intelligence of the ${COMPANY.name} operating system.
You are the digital twin of the entire company: every department, every agent, every number
in this OS is part of you. You speak to the owner and their executives.

Voice: a sharp, trusted COO. Concise, plain language, numbers first, zero fluff, zero
tech-speak. One tight paragraph unless asked to go deeper. Warm but direct — this is a
white-glove, relationship-first company (${COMPANY.brandVoice}).

Ground rules:
- The LIVE SNAPSHOT below is your only source of numbers. Never invent or estimate a figure
  that isn't there — say what you'd need instead.
- Reversible, in-house actions (open a dashboard, summarize, draft) you do directly. Anything
  that leaves the building (send, publish, charge, promise) is drafted for human approval.
- You can drive the screen: call open_tab when the user should be looking at a dashboard.
- When asked "how are we doing", lead with the one number that matters most today, then the
  two runners-up. Never dump every metric.
`.trim();

/* ── keyless twin: answers straight from the data ── */

function degradedTwin(text: string, s: Snapshot): { text: string; navigate?: string } {
  const t = text.toLowerCase();
  const money = (v: number) => '$' + Math.round(v).toLocaleString('en-US');
  if (/invoice|owe|outstanding|receivab|collect|money|cash|paid/.test(t) && s.recv)
    return {
      text: `${money(s.recv.totalOutstanding)} outstanding across ${s.recv.count} invoices — ${money(s.recv.collectedThisMonth)} collected this month. The Invoice Collector is on it; open Invoices to see the aging.`,
      navigate: 'invoices',
    };
  if (/review|reputation|rating|google/.test(t) && s.rep)
    return {
      text: `You're holding ${s.rep.avgRating.toFixed(1)}★ across ${s.rep.totalReviews} reviews, ${s.rep.thisMonthDelta >= 0 ? '+' : ''}${s.rep.thisMonthDelta} this month. Open Reviews for the drafts waiting on your approval.`,
      navigate: 'reviews',
    };
  if (/call|phone|lead|front desk|reception/.test(t) && s.calls)
    return {
      text: `${s.calls.callsToday} calls today, ${s.calls.leadsCaptured} leads captured, ${s.calls.transferred} routed to the right team. The receptionist has the line.`,
      navigate: 'calls',
    };
  if (/gap|audit|map|agent|build/.test(t) && s.audit)
    return {
      text: `The operation is ${s.audit.coverage}% mapped with ${s.audit.leaks} open gaps and ${s.audit.builds} AI builds identified. The Harness works the queue.`,
    };
  return {
    text:
      `Here's where the company stands: ` +
      (s.lines.slice(0, 3).join(' ') || 'the dashboards are loading their first data.') +
      ` Ask me about money, calls, reputation, or the gaps. (Add an LLM key for full conversation.)`,
  };
}

/* ── the turn ── */

export interface TwinTurn {
  text: string;
  navigate?: string;
}

export async function runOperatorTurn(userText: string): Promise<TwinTurn> {
  const snap = liveSnapshot();
  if (activeProvider() === 'none') return degradedTwin(userText, snap);

  const mem = await memoryContext(userText);
  const system = [
    TWIN_SYSTEM(),
    `LIVE SNAPSHOT (your ground truth, just refreshed):\n${snap.lines.map((l) => '- ' + l).join('\n')}`,
    mem,
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userText },
  ];

  let navigate: string | undefined;
  let finalText = '';
  for (let hop = 0; hop < 4; hop++) {
    const result = await chat(messages, { tools: TOOLS, maxTokens: 700 });
    if (!result) return degradedTwin(userText, snap);
    if (result.text) finalText = result.text;
    if (!result.toolCalls.length) break;
    for (const call of result.toolCalls) {
      const tr = await executeTool(call.name, call.args);
      if (tr.navigate) navigate = tr.navigate;
      messages.push({ role: 'assistant', content: `(called ${call.name})` });
      messages.push({ role: 'user', content: `Tool result: ${tr.message}` });
    }
  }
  if (!finalText) finalText = 'Done.';
  return { text: finalText, navigate };
}

/** SSE: navigate → sentence tokens → done. The client renders a typewriter over these. */
export async function streamOperatorTurn(userText: string, res: Response): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const turn = await runOperatorTurn(userText);
    if (turn.navigate) send('navigate', { tab: turn.navigate });
    const sentences = turn.text.match(/[^.!?]+[.!?]*/g) || [turn.text];
    for (const s of sentences) if (s.trim()) send('token', { text: s.trim() + ' ' });
    send('done', { text: turn.text });
  } catch (err) {
    send('error', { message: (err as Error).message });
  } finally {
    res.end();
  }
}
