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
    role: 'Answers calls 24/7, books jobs, captures leads',
    home: true,
    status: 'connecting',
    connectVia: ['vapi', 'elevenlabs'],
  },
  {
    key: 'invoices',
    name: 'Invoice Collector',
    role: 'Chases receivables, drafts reminders, tracks aging',
    status: 'standalone',
    connectVia: ['quickbooks', 'stripe', 'gmail'],
  },
  {
    key: 'reviews',
    name: 'Review Collector',
    role: 'Requests reviews, drafts replies, tracks reputation',
    status: 'standalone',
    connectVia: ['google_business', 'gmail'],
  },
];

export function agentByKey(key: string): AgentDef | undefined {
  return AGENTS.find((a) => a.key === key);
}
