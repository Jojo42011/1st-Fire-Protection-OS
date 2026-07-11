/**
 * The integration catalog — every "hand" the system CAN plug into, with live status
 * resolved from process.env. This is the "show what it could do" surface.
 * Adding a hand = one entry here.
 */

export type IntegrationStatus = 'connected' | 'available' | 'planned';

export interface IntegrationDef {
  id: string;
  name: string;
  category: string;
  why: string; // why it matters for 1st FP
  /** returns true when this integration's keys are present */
  isConnected: () => boolean;
  /** 'available' means fully built & one key away; 'planned' means roadmap */
  baseline: 'available' | 'planned';
}

const CATALOG: IntegrationDef[] = [
  {
    id: 'vapi',
    name: 'Vapi / Twilio (Voice)',
    category: 'Voice & Telephony',
    why: 'Powers the Call Receptionist — answers inbound calls 24/7.',
    baseline: 'planned',
    isConnected: () =>
      !!(process.env.VAPI_API_KEY || (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)),
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    category: 'Voice & Telephony',
    why: 'Realtime STT + TTS voice for the receptionist.',
    baseline: 'available',
    isConnected: () => !!process.env.ELEVENLABS_API_KEY,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'AI & Reasoning',
    why: 'The brain + embeddings for the memory graph.',
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
    id: 'quickbooks',
    name: 'QuickBooks',
    category: 'Payments & Finance',
    why: 'Pull real receivables into the Invoice Collector.',
    baseline: 'planned',
    isConnected: () => !!process.env.QUICKBOOKS_ACCESS_TOKEN,
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Payments & Finance',
    why: 'Collect deposits / let customers pay invoices online.',
    baseline: 'planned',
    isConnected: () => !!process.env.STRIPE_API_KEY,
  },
  {
    id: 'google_business',
    name: 'Google Business Profile',
    category: 'Leads & CRM',
    why: 'Pull in and reply to reviews for the Review Collector.',
    baseline: 'planned',
    isConnected: () => !!process.env.GOOGLE_BUSINESS_TOKEN,
  },
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'Messaging',
    why: 'Send approved invoice reminders + review-request emails.',
    baseline: 'planned',
    isConnected: () => !!process.env.GMAIL_ACCESS_TOKEN,
  },
  {
    id: 'sms',
    name: 'SMS (Twilio / sms-gate)',
    category: 'Messaging',
    why: 'Text payment reminders + review requests.',
    baseline: 'planned',
    isConnected: () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_FROM_NUMBER),
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Website & SEO',
    why: 'Ship site/SEO changes if you later add the SEO agent.',
    baseline: 'available',
    isConnected: () => !!process.env.GITHUB_TOKEN,
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
