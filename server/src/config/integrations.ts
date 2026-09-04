/**
 * Integration catalog — every external "hand" the OS can plug into.
 *
 * Systemize rule: direct API / owned adapter / MCP first. Agent-platform and
 * browser automation are lower-priority execution paths. No integration here is
 * allowed to become the authoritative business/workflow state store.
 */
import { googleConnected } from '../services/googleBusiness';

export type IntegrationStatus = 'connected' | 'available' | 'planned';

export interface IntegrationDef {
  id: string;
  name: string;
  category: string;
  why: string;
  isConnected: () => boolean;
  baseline: 'available' | 'planned';
}

const CATALOG: IntegrationDef[] = [
  {
    id: 'relevance_ai',
    name: 'Relevance AI',
    category: 'AI Workforce',
    why: 'Judgment-heavy specialist agents and multi-agent delegation. The OS remains the source of truth for workflow state, approvals and external resources.',
    baseline: 'available',
    isConnected: () => !!(process.env.RELEVANCE_API_URL && process.env.RELEVANCE_API_KEY),
  },
  {
    id: 'inngest',
    name: 'Inngest',
    category: 'Durable Execution',
    why: 'Checkpointed, retriable, scheduled and event-driven workflows. Systemize keeps its own run/action/resource ledger so the runtime stays replaceable.',
    baseline: 'available',
    isConnected: () => !!process.env.INNGEST_EVENT_KEY,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'AI & Reasoning',
    why: 'Optional model aggregation/routing behind the Systemize ModelGateway. Direct model providers remain supported.',
    baseline: 'available',
    isConnected: () => !!(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL),
  },
  {
    id: 'langfuse',
    name: 'Langfuse',
    category: 'AI Observability',
    why: 'Prompt/model/tool traces, evaluations, datasets and cost/quality monitoring. Never used as the business workflow database.',
    baseline: 'available',
    isConnected: () => !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
  },
  {
    id: 'mcp',
    name: 'Systemize MCP / Tool Adapters',
    category: 'Integration Runtime',
    why: 'Owned capability contracts that let ChatGPT, Claude, Relevance and custom agents use the same controlled integrations.',
    baseline: 'available',
    isConnected: () => !!process.env.SYSTEMIZE_MCP_ENABLED,
  },
  {
    id: 'computer_use',
    name: 'Computer-use Agent',
    category: 'Fallback Automation',
    why: 'Last-resort browser/computer execution for systems without reliable APIs or adapters. Consequential actions require stronger verification and approval.',
    baseline: 'planned',
    isConnected: () => !!process.env.COMPUTER_USE_ENABLED,
  },
  {
    id: 'vapi',
    name: 'Vapi (AI Voice)',
    category: 'Voice & Telephony',
    why: 'Answers the main line, classifies the call and transfers into Teams.',
    baseline: 'planned',
    isConnected: () => !!process.env.VAPI_API_KEY,
  },
  {
    id: 'twilio',
    name: 'Twilio',
    category: 'Voice & Telephony',
    why: 'Telephony and SMS transport for the receptionist and approved messaging workflows.',
    baseline: 'planned',
    isConnected: () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    category: 'Voice & Telephony',
    why: 'Realtime natural TTS voice for the receptionist.',
    baseline: 'available',
    isConnected: () => !!process.env.ELEVENLABS_API_KEY,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'AI & Reasoning',
    why: 'Direct model provider and embeddings path. Business workflows should access it through model/tool abstractions.',
    baseline: 'available',
    isConnected: () => !!process.env.OPENAI_API_KEY,
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    category: 'AI & Reasoning',
    why: 'Direct model provider for reasoning, drafting and extraction. Business workflows should access it through model/tool abstractions.',
    baseline: 'available',
    isConnected: () => !!process.env.ANTHROPIC_API_KEY,
  },
  {
    id: 'servicetrade',
    name: 'ServiceTrade',
    category: 'Field Service (System of Record)',
    why: 'Jobs, inspections, deficiencies, quotes, invoices and completion context.',
    baseline: 'planned',
    isConnected: () => !!(process.env.SERVICETRADE_TOKEN || (process.env.SERVICETRADE_USERNAME && process.env.SERVICETRADE_PASSWORD)),
  },
  {
    id: 'microsoft365',
    name: 'Microsoft 365 / Graph / Teams',
    category: 'Comms & Ops',
    why: 'Identity, email, Teams, files, groups and office operations.',
    baseline: 'planned',
    isConnected: () => !!(process.env.MS365_TOKEN || process.env.MS_GRAPH_TOKEN),
  },
  {
    id: 'google_business',
    name: 'Google Business Profile',
    category: 'Reputation',
    why: 'Read reviews and publish human-approved replies.',
    baseline: 'planned',
    isConnected: () => !!process.env.GOOGLE_BUSINESS_TOKEN || googleConnected(),
  },
  {
    id: 'facebook',
    name: 'Facebook / Meta',
    category: 'Marketing & Reputation',
    why: 'Pages, lead forms and Meta Ads. Creation/publishing workflows must use idempotency keys and approval gates.',
    baseline: 'planned',
    isConnected: () => !!(process.env.FACEBOOK_PAGE_TOKEN || process.env.META_ACCESS_TOKEN),
  },
  {
    id: 'sage_intacct',
    name: 'Sage Intacct',
    category: 'Payments & Finance',
    why: 'Accounting system of record for receivables, financial truth and finance workflows.',
    baseline: 'planned',
    isConnected: () =>
      !!(process.env.INTACCT_SENDER_ID && process.env.INTACCT_SENDER_PASSWORD && process.env.INTACCT_COMPANY_ID && process.env.INTACCT_USER_ID && process.env.INTACCT_USER_PASSWORD),
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Payments & Finance',
    why: 'Payments and deposits. Financial side effects are high-risk actions and remain approval-controlled.',
    baseline: 'planned',
    isConnected: () => !!process.env.STRIPE_API_KEY,
  },
  {
    id: 'sms',
    name: 'SMS (Twilio)',
    category: 'Messaging',
    why: 'Approved payment reminders, review requests and operational messages.',
    baseline: 'planned',
    isConnected: () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_FROM_NUMBER),
  },
  {
    id: 'gmail',
    name: 'Email (M365 / Gmail)',
    category: 'Messaging',
    why: 'Approved customer-facing email sends.',
    baseline: 'planned',
    isConnected: () => !!(process.env.GMAIL_ACCESS_TOKEN || process.env.MS365_TOKEN || process.env.MS_GRAPH_TOKEN),
  },
  {
    id: 'n8n',
    name: 'n8n',
    category: 'Prototype Automation',
    why: 'Fast experiments and client-specific glue. Repeated/high-value workflows should be promoted into code-owned durable workflows.',
    baseline: 'available',
    isConnected: () => !!process.env.N8N_API_KEY,
  },
  {
    id: 'bamboo',
    name: 'BambooHR',
    category: 'People & HR',
    why: 'Active-roster source of truth for onboarding/offboarding and license/access reconciliation.',
    baseline: 'planned',
    isConnected: () => !!(process.env.BAMBOO_SUBDOMAIN && process.env.BAMBOO_API_KEY),
  },
  {
    id: 'adobe',
    name: 'Adobe (Creative Cloud)',
    category: 'Software Licensing',
    why: 'Creative Cloud seat assignments for license reconciliation.',
    baseline: 'planned',
    isConnected: () => !!process.env.ADOBE_UMAPI_TOKEN,
  },
  {
    id: 'bluebeam',
    name: 'Bluebeam Revu',
    category: 'Software Licensing',
    why: 'Bluebeam seat assignments for license reconciliation.',
    baseline: 'planned',
    isConnected: () => !!process.env.BLUEBEAM_API_KEY,
  },
  {
    id: 'autodesk',
    name: 'AutoCAD (Autodesk)',
    category: 'Software Licensing',
    why: 'Autodesk/AutoCAD seat assignments for license reconciliation.',
    baseline: 'planned',
    isConnected: () => !!process.env.AUTODESK_TOKEN,
  },
  {
    id: 'hydracad',
    name: 'HydraCAD',
    category: 'Software Licensing',
    why: 'HydraCAD license roster for license reconciliation.',
    baseline: 'planned',
    isConnected: () => !!process.env.HYDRACAD_API_KEY,
  },
  {
    id: 'hfss',
    name: 'HFSS',
    category: 'Software Licensing',
    why: 'HFSS seat assignments for license reconciliation.',
    baseline: 'planned',
    isConnected: () => !!process.env.HFSS_API_KEY,
  },
  {
    id: 'ms_licensing',
    name: 'Microsoft 365 Licensing',
    category: 'Software Licensing',
    why: 'Microsoft 365 seat assignments via Graph for license reconciliation.',
    baseline: 'planned',
    isConnected: () => !!process.env.MS_GRAPH_TOKEN,
  },
];

export interface ResolvedIntegration {
  id: string;
  name: string;
  category: string;
  why: string;
  status: IntegrationStatus;
}

export function resolveIntegrations(): ResolvedIntegration[] {
  return CATALOG.map((i) => {
    let status: IntegrationStatus;
    if (i.isConnected()) status = 'connected';
    else if (i.baseline === 'available') status = 'available';
    else status = 'planned';
    return { id: i.id, name: i.name, category: i.category, why: i.why, status };
  });
}

export function integrationConnected(id: string): boolean {
  const found = CATALOG.find((i) => i.id === id);
  return found ? found.isConnected() : false;
}
