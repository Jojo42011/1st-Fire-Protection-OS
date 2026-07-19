# Generated agent modules (harness output)

The Harness's coder (Kimi K2 by default) writes a real TypeScript module here for each new
agent it builds. **These are reviewable artifacts, not live code.** A module lands here only
when a human reviews the diff on the Harness tab and merges it through the normal dev
pipeline. Nothing in this folder is hot-loaded or auto-executed by the running app.

Every module implements one contract:

```ts
export interface AgentInput   { text: string; data?: Record<string, unknown> }
export interface AgentContext { remember(s: string, p: string, o: string): Promise<void>;
                                recall(q: string): Promise<string[]>;
                                company: { name: string; industry: string } }
export interface AgentResult  { text: string; actions?: string[] }
export const meta = { key, name, pillar, capability }
export async function handle(input: AgentInput, ctx: AgentContext): Promise<AgentResult>
```

Flow: the Operator finds a gap, the Harness drafts the agent (persona + skills) and has the
coder write this module, you review it here, then ship. The agent runs as data the moment it
is shipped; merging its module is what gives it hard-coded logic.
