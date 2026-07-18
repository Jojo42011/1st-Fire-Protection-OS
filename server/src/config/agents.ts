/**
 * The agent registry. The shell TABS, the Integrations "team" view, and the brain's
 * open_tab enum can all be generated from this. Swap this array per company.
 */
export interface AgentDef {
  key: string; // tab key + route prefix
  name: string; // "Invoice Collector"
  role: string; // one-line job
  home?: boolean; // the always-live tab (the receptionist)
  status: 'live' | 'connecting' | 'standalone';
  connectVia?: string[]; // integration ids that make it "live"
}

export const AGENTS: AgentDef[] = [
  {
    key: 'calls',
    name: 'Call Receptionist',
    role: 'Answers the SA line 24/7, classifies & routes into Teams, captures leads',
    home: true,
    status: 'connecting',
    connectVia: ['vapi', 'twilio', 'elevenlabs', 'microsoft365'],
  },
  {
    key: 'invoices',
    name: 'Invoice Collector',
    role: 'Chases receivables, drafts reminders, tracks aging',
    status: 'standalone',
    connectVia: ['servicetrade', 'stripe', 'gmail'],
  },
  {
    key: 'reviews',
    name: 'Review Collector',
    role: 'Requests reviews on job completion, drafts replies, tracks reputation',
    status: 'standalone',
    connectVia: ['servicetrade', 'google_business', 'facebook'],
  },
  {
    key: 'audit',
    name: 'The Operator',
    role: 'Enterprise audit brain — maps the operation live, finds the leaks, matches the AI builds',
    status: 'standalone',
    connectVia: ['anthropic', 'openai'],
  },
];

export function agentByKey(key: string): AgentDef | undefined {
  return AGENTS.find((a) => a.key === key);
}
