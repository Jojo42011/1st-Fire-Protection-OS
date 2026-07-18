import { Response } from 'express';
import { chat, ChatMessage } from '../services/llm';
import { TOOLS, executeTool } from './tools';
import { BRAIN_SYSTEM_PROMPT, RECEPTIONIST_SYSTEM_PROMPT, COMPANY } from '../config/constants';
import { memoryContext } from '../db/memory';
import { extractMemory } from '../services/extraction';
import { activeProvider } from '../config/models';

/**
 * The core agent loop: assemble system prompt (founder layer + memory + live data),
 * call the LLM with tools, run the tool loop, stream results. One non-streaming entry,
 * one SSE entry. Emits navigate directives for the shell.
 */

async function assembleSystem(userText: string, home: boolean): Promise<string> {
  const persona = home ? RECEPTIONIST_SYSTEM_PROMPT : BRAIN_SYSTEM_PROMPT;
  const mem = await memoryContext(userText);
  const liveHint = `Company: ${COMPANY.name}. Area: ${COMPANY.area}. Hours: ${COMPANY.hours}.`;
  return [persona, liveHint, mem].filter(Boolean).join('\n\n');
}

/** Deterministic degraded reply when no LLM provider is configured. */
function degradedReply(userText: string): string {
  const t = userText.toLowerCase();
  if (t.includes('invoice') || t.includes('owe') || t.includes('receivable'))
    return "I can open the Invoice Collector for you — it's tracking receivables and drafting reminders on seeded data. (Connect OpenAI or Anthropic to enable full conversation.)";
  if (t.includes('review') || t.includes('reputation'))
    return 'The Review Collector is up on sample data — I can open it. (Add an LLM key for live drafting.)';
  if (t.includes('call') || t.includes('lead'))
    return "The Call Receptionist is built and connecting soon — it'll answer calls and capture leads once a voice key is added.";
  if (t.includes('audit') || t.includes('operator'))
    return 'The Operator is ready — open the Audit tab and it will map the operation live: pillars, leaks, veterans, and the AI builds that fix them.';
  return `Hi, this is the front desk for ${COMPANY.name}. I'm running in offline mode — add an OpenAI or Anthropic key to enable full conversation. I can still open any dashboard tab for you.`;
}

interface Turn {
  text: string;
  navigate?: string;
}

/** Non-streaming entry: returns final text + optional navigation. */
export async function runTurn(userText: string, home = true): Promise<Turn> {
  if (activeProvider() === 'none') {
    return { text: degradedReply(userText) };
  }

  const system = await assembleSystem(userText, home);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userText },
  ];

  let navigate: string | undefined;
  let finalText = '';

  for (let hop = 0; hop < 4; hop++) {
    const result = await chat(messages, { tools: TOOLS, maxTokens: 800 });
    if (!result) {
      finalText = degradedReply(userText);
      break;
    }
    if (result.text) finalText = result.text;

    if (!result.toolCalls.length) break;

    // execute tools, append results, loop
    for (const call of result.toolCalls) {
      const tr = await executeTool(call.name, call.args);
      if (tr.navigate) navigate = tr.navigate;
      messages.push({ role: 'assistant', content: `(called ${call.name})` });
      messages.push({ role: 'user', content: `Tool result: ${tr.message}` });
    }
  }

  if (!finalText) finalText = 'Done.';
  extractMemory(home ? 'receptionist' : 'brain', userText, finalText);
  return { text: finalText, navigate };
}

/** SSE entry: streams token-ish chunks + navigate + done events. */
export async function streamTurn(userText: string, res: Response, home = true): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const turn = await runTurn(userText, home);
    if (turn.navigate) send('navigate', { tab: turn.navigate });

    // sentence-chunk the reply so the client can TTS/print progressively
    const sentences = turn.text.match(/[^.!?]+[.!?]*/g) || [turn.text];
    for (const s of sentences) {
      if (s.trim()) send('token', { text: s.trim() + ' ' });
    }
    send('done', { text: turn.text });
  } catch (err) {
    send('error', { message: (err as Error).message });
  } finally {
    res.end();
  }
}
