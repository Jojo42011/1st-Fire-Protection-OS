/**
 * The integration catalog — every "hand" the system CAN plug into, with live status
 * resolved from process.env. This is the "show what it could do" surface.
 *
 * Wired to 1st FP's REAL stack: ServiceTrade (field service system of record), Vapi + Twilio
 * (telephony into Microsoft Teams), Microsoft 365, Google Business Profile + Facebook (reviews).
 */

export type IntegrationStatus = 'connected' | 'available' | 'planned';

export interface IntegrationDef {
  id: string;
  name: string;
  category: string;
  why: string; // why it matters for 1st FP
  isConnected: () => boolean;
  baseline: 'available' | 'planned';
}

const CATALOG: IntegrationDef[] = [
  {
    id: 'vapi',
    name: 'Vapi (AI Voice)',
    category: 'Voice & Telephony',
    why: 'Answers the San Antonio line, classifies the call, transfers into Teams. Bring-your-own OpenAI key.',
    baseline: 'planned',
    isConnected: () => !!process.env.VAPI_API_KEY,
  },
  {
    id: 'twilio',
    name: 'Twilio',
    category: 'Voice & Telephony',
    why: 'Forwards 210-377-FIRE to the AI agent, then transfers back into Teams (Phase 1, no porting risk).',
    baseline: 'planned',
    isConnected: () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    category: 'Voice & Telephony',
    why: 'Realtime, natural TTS voice for the receptionist.',
    baseline: 'available',
    isConnected: () => !!process.env.ELEVENLABS_API_KEY,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'AI & Reasoning',
    why: 'The brain + embeddings for the memory graph; also powers Vapi.',
    baseline: 'available',
    isConnected: () => !!process.env.OPENAI_API_KEY,
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    category: 'AI & Reasoning',
    why: 'Memory extraction / reflection / on-brand drafting.',
    baseline: 'available',
    isConnected: () => !!process.env.ANTHROPIC_API_KEY,
  },
  {
    id: 'servicetrade',
    name: 'ServiceTrade',
    category: 'Field Service (System of Record)',
    why: 'Jobs, invoices & completions. Job completion → review request; open invoices → the collector.',
    baseline: 'planned',
    isConnected: () => !!process.env.SERVICETRADE_TOKEN,
  },
  {
    id: 'microsoft365',
    name: 'Microsoft 365 / Teams',
    category: 'Comms & Ops',
    why: 'Call transfers land in Teams; M365 is the office backbone.',
    baseline: 'planned',
    isConnected: () => !!process.env.MS365_TOKEN,
  },
  {
    id: 'google_business',
    name: 'Google Business Profile',
    category: 'Reputation',
    why: 'Pull in and reply to Google reviews for the Review Collector.',
    baseline: 'planned',
    isConnected: () => !!process.env.GOOGLE_BUSINESS_TOKEN,
  },
  {
    id: 'facebook',
    name: 'Facebook Pages',
    category: 'Reputation',
    why: 'Second review funnel — recommendations & replies.',
    baseline: 'planned',
    isConnected: () => !!process.env.FACEBOOK_PAGE_TOKEN,
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Payments & Finance',
    why: 'Let customers pay invoices online; collect deposits.',
    baseline: 'planned',
    isConnected: () => !!process.env.STRIPE_API_KEY,
  },
  {
    id: 'sms',
    name: 'SMS (Twilio)',
    category: 'Messaging',
    why: 'Text payment reminders + post-job review requests.',
    baseline: 'planned',
    isConnected: () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_FROM_NUMBER),
  },
  {
    id: 'gmail',
    name: 'Email (M365 / Gmail)',
    category: 'Messaging',
    why: 'Send approved invoice reminders + review-request emails.',
    baseline: 'planned',
    isConnected: () => !!(process.env.GMAIL_ACCESS_TOKEN || process.env.MS365_TOKEN),
  },
  {
    id: 'n8n',
    name: 'n8n',
    category: 'Automation',
    why: 'Orchestrates receptionist call logging + post-job review-request workflows.',
    baseline: 'available',
    isConnected: () => !!process.env.N8N_API_KEY,
  },
  {
    id: 'bamboo',
    name: 'BambooHR',
    category: 'People & HR',
    why: 'The active-roster source of truth. Reconciled against software-license seats to reclaim licenses still assigned to people who have left.',
    baseline: 'planned',
    isConnected: () => !!(process.env.BAMBOO_SUBDOMAIN && process.env.BAMBOO_API_KEY),
  },
  {
    id: 'adobe',
    name: 'Adobe (Creative Cloud)',
    category: 'Software Licensing',
    why: 'Creative Cloud seat assignments (via UMAPI) for the License Reclaim reconciliation.',
    baseline: 'planned',
    isConnected: () => !!process.env.ADOBE_UMAPI_TOKEN,
  },
  {
    id: 'bluebeam',
    name: 'Bluebeam Revu',
    category: 'Software Licensing',
    why: 'Bluebeam Revu seat assignments for License Reclaim (a separate product from HydroCAD).',
    baseline: 'planned',
    isConnected: () => !!process.env.BLUEBEAM_API_KEY,
  },
  {
    id: 'autodesk',
    name: 'AutoCAD (Autodesk)',
    category: 'Software Licensing',
    why: 'Autodesk / AutoCAD seat assignments for License Reclaim.',
    baseline: 'planned',
    isConnected: () => !!process.env.AUTODESK_TOKEN,
  },
  {
    id: 'hydrocad',
    name: 'HydroCAD',
    category: 'Software Licensing',
    why: 'HydroCAD license roster for License Reclaim (a separate product from Bluebeam).',
    baseline: 'planned',
    isConnected: () => !!process.env.HYDROCAD_API_KEY,
  },
  {
    id: 'ms_licensing',
    name: 'Microsoft 365 Licensing',
    category: 'Software Licensing',
    why: 'Microsoft 365 seat assignments (via Graph) for the License Reclaim reconciliation.',
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

/** Resolve live status from env at call time (graceful — never throws). */
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
