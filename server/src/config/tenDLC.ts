/**
 * A2P 10DLC registration fields for 1st Fire Protection.
 *
 * Twilio (via The Campaign Registry) requires two things before an app can send
 * SMS from a US local number: a **Brand** (who the business is) and a **Campaign**
 * (what the messages are + how consumers consented). This file assembles both
 * payloads from the founder layer (`COMPANY`) so the operator can copy them
 * straight into the Twilio console, and so a future direct-submit integration
 * has one typed source of truth.
 *
 * Follows the house rules:
 *  - Everything derivable from `COMPANY` is filled in for you.
 *  - The few facts only the business owns (EIN, the human contact, the DUNS)
 *    are marked with `NEEDS_INPUT` and can be supplied via env WITHOUT a code
 *    change (graceful — a keyless boot still renders the whole form).
 */

import { COMPANY } from './constants';

/** Sentinel for a value the operator must supply before submitting to Twilio. */
export const NEEDS_INPUT = '⟨NEEDS INPUT⟩' as const;

const env = (k: string, fallback: string = NEEDS_INPUT) => process.env[k] || fallback;

/**
 * Twilio / TCR brand entity type. 1st FP Services, LLC is a for-profit LLC → PRIVATE_PROFIT.
 * (Others: PUBLIC_PROFIT, NON_PROFIT, GOVERNMENT, SOLE_PROPRIETOR.)
 */
export type EntityType = 'PRIVATE_PROFIT' | 'PUBLIC_PROFIT' | 'NON_PROFIT' | 'GOVERNMENT' | 'SOLE_PROPRIETOR';

/** TCR industry vertical. Fire-protection / life-safety maps to CONSTRUCTION. */
export type Vertical =
  | 'CONSTRUCTION' | 'PROFESSIONAL' | 'REAL_ESTATE' | 'MANUFACTURING' | 'ENERGY'
  | 'TECHNOLOGY' | 'RETAIL' | 'HEALTHCARE' | 'FINANCIAL' | 'GOVERNMENT';

export interface BrandRegistration {
  /** Exact legal name as registered with the IRS / Secretary of State. */
  legalBusinessName: string;
  /** Public-facing brand / DBA. */
  brandName: string;
  entityType: EntityType;
  /** US Tax ID / EIN (9 digits, no dash). Operator-supplied. */
  ein: string;
  einIssuingCountry: string;
  /** D-U-N-S number — optional but speeds vetting for a Standard brand. */
  duns: string;
  vertical: Vertical;
  website: string;
  /** Registered business address. */
  address: {
    street: string;
    city: string;
    state: string; // 2-letter for US
    postalCode: string;
    country: string; // ISO-2
  };
  /** Authorized business-contact person (the human TCR may verify). */
  contact: {
    firstName: string;
    lastName: string;
    title: string;
    email: string;
    phone: string; // E.164
  };
  /** Where the business operates / sends messages. */
  regionsOfOperation: string;
}

export interface CampaignRegistration {
  /** TCR use case. Payment reminders + review requests + service notices → MIXED. */
  useCase: 'MIXED' | 'LOW_VOLUME' | 'CUSTOMER_CARE' | 'ACCOUNT_NOTIFICATION' | 'MARKETING';
  description: string;
  /** 2–5 representative messages (must match what is actually sent). */
  sampleMessages: string[];
  /** How consumers opt in (the single most-scrutinized field). */
  optInFlow: string;
  optInKeywords: string[];
  optInMessage: string;
  optOutKeywords: string[];
  optOutMessage: string;
  helpKeywords: string[];
  helpMessage: string;
  /** Content attributes TCR asks you to declare. */
  content: {
    embeddedLinks: boolean;
    embeddedPhone: boolean;
    ageGated: boolean;
    directLending: boolean;
    affiliateMarketing: boolean;
  };
}

// E.164 form of the San Antonio line, from COMPANY.phone (digits only).
const phoneE164 = '+1' + COMPANY.phone.replace(/\D/g, '');

export const BRAND: BrandRegistration = {
  legalBusinessName: '1st FP Services, LLC',
  brandName: COMPANY.name, // "1st Fire Protection"
  entityType: 'PRIVATE_PROFIT',
  ein: env('TWILIO_A2P_EIN'),
  einIssuingCountry: 'US',
  duns: env('TWILIO_A2P_DUNS', ''), // optional — leave blank if unknown
  vertical: 'CONSTRUCTION',
  website: 'https://' + COMPANY.site, // https://1stfpcompanies.com
  address: {
    // "11550 N North Loop Rd, Bldg 1 #1, San Antonio, TX 78216"
    street: '11550 N North Loop Rd, Bldg 1 #1',
    city: 'San Antonio',
    state: 'TX',
    postalCode: '78216',
    country: 'US',
  },
  contact: {
    // The authorized rep who can attest to the registration. Confirm before submitting.
    firstName: env('TWILIO_A2P_CONTACT_FIRST', 'Chris'),
    lastName: env('TWILIO_A2P_CONTACT_LAST', 'Holcomb'),
    title: env('TWILIO_A2P_CONTACT_TITLE', 'Chief Operating Officer'),
    email: env('TWILIO_A2P_CONTACT_EMAIL', COMPANY.email),
    phone: env('TWILIO_A2P_CONTACT_PHONE', phoneE164),
  },
  regionsOfOperation: 'USA — Central & South Texas',
};

export const CAMPAIGN: CampaignRegistration = {
  useCase: 'MIXED',
  description:
    'Transactional customer-care messages to existing 1st Fire Protection customers: ' +
    'fire-inspection and service appointment reminders, invoice/payment reminders, and ' +
    'post-service review requests. Recipients are our own customers who provided their ' +
    'mobile number and consented to SMS during service scheduling or on their signed work order.',
  sampleMessages: [
    'Hi {{name}}, this is 1st Fire Protection. Your annual fire-sprinkler inspection at ' +
      '{{site}} is scheduled for {{date}}. Reply C to confirm or call 210-377-FIRE to reschedule. Reply STOP to opt out.',
    'Hi {{name}}, 1st Fire Protection here — invoice {{invoice}} for {{amount}} is now due. ' +
      'Pay securely at {{link}} or call 210-377-3473 with questions. Reply STOP to opt out.',
    'Thanks for choosing 1st Fire Protection, {{name}}! If we kept you safe today, a quick ' +
      'review means a lot: {{link}}. Reply STOP to opt out.',
  ],
  optInFlow:
    'Customers provide their mobile number and agree to receive service and account text ' +
    'messages when they schedule work by phone (verbal consent captured by our office) or by ' +
    'signing a 1st Fire Protection work order / service agreement that includes an SMS-consent ' +
    'clause. No numbers are purchased, rented, or shared. Message frequency varies; message and ' +
    'data rates may apply.',
  optInKeywords: ['START', 'YES', 'UNSTOP'],
  optInMessage:
    "1st Fire Protection: You're subscribed to service & account alerts. Msg frequency varies. " +
    'Msg & data rates may apply. Reply HELP for help, STOP to cancel.',
  optOutKeywords: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
  optOutMessage:
    "1st Fire Protection: You're unsubscribed and will get no more messages. Reply START to resubscribe.",
  helpKeywords: ['HELP', 'INFO'],
  helpMessage:
    '1st Fire Protection support: call 210-377-3473 (210-377-FIRE) or email ' +
    COMPANY.email + '. Msg & data rates may apply. Reply STOP to cancel.',
  content: {
    embeddedLinks: true, // payment + review links
    embeddedPhone: true, // 210-377-FIRE appears in messages
    ageGated: false,
    directLending: false,
    affiliateMarketing: false,
  },
};

/** True once every operator-only field has a real value (safe to submit). */
export function tenDlcReady(): boolean {
  return missingFields().length === 0;
}

/** The still-blank operator-only fields, as human-readable labels. */
export function missingFields(): string[] {
  const gaps: string[] = [];
  if (BRAND.ein === NEEDS_INPUT) gaps.push('Brand → EIN / Tax ID');
  if (BRAND.contact.firstName === NEEDS_INPUT) gaps.push('Brand → Authorized contact');
  if (BRAND.contact.email === NEEDS_INPUT) gaps.push('Brand → Contact email');
  return gaps;
}

/** The full registration packet — Brand + Campaign + readiness — for the API/UI. */
export function tenDlcRegistration() {
  return {
    brand: BRAND,
    campaign: CAMPAIGN,
    ready: tenDlcReady(),
    missing: missingFields(),
  };
}
