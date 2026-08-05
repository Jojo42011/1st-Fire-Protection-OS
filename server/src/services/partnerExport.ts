import { getDb } from '../db/index';
import { integrationConnected } from '../config/integrations';

/**
 * Partner cross-sell export — 1st FP's OWN commercial customers, shaped as warm
 * security leads for the sister company (VDS). This is a deliberate, sanctioned
 * channel between two commonly-owned companies; only 1st FP's own customer data
 * crosses, and nothing else. It is separate from /api/introspect (which is
 * metadata-only). Consumers score and work these on their side.
 *
 * Sources: invoices (paying commercial customers), jobs (on-site work =
 * relationship + recurring access), leads (recent inbound with addresses), and
 * partner_flags (a tech physically flagged the site — highest intent).
 */

export interface PartnerLead {
  externalId: string;
  company: string;
  contact: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  propertyType: string;
  serviceType: string;        // 1st FP's line of work for them (fire/life-safety detail)
  fireRelationship: string;   // strong | normal | new
  onSiteFrequency: string;    // high | normal | low
  lifetimeValue: number;      // total invoiced, a proxy for account size
  lastJobAt: string;
  triggerEvent: string;       // a recent event that opens a security conversation
  techFlagged: boolean;       // a 1st FP tech flagged this site in person
  hasSecurityVendor: boolean; // unknown from fire data; default greenfield (verify on contact)
  notes: string;
  source: string;             // "1st FP book" | "tech flag"
}

const norm = (s: string) => (s || '').trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
const slug = (s: string) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Rough property-type inference from the customer name / work description, mapped
// to the categories the VDS scorer understands.
function propertyType(name: string, desc: string): string {
  const t = (name + ' ' + desc).toLowerCase();
  if (/\bisd\b|school|district|university|college|academy/.test(t)) return 'education';
  if (/hospital|medical|clinic|health|surgery/.test(t)) return 'healthcare';
  if (/data center|distribution|warehouse|logistics|manufactur|industrial|plant/.test(t)) return 'industrial';
  if (/apartment|multifamily|residence|living|housing/.test(t)) return 'multifamily';
  if (/storage/.test(t)) return 'storage';
  if (/hotel|hospitality|resort|convention|restaurant/.test(t)) return 'hospitality';
  if (/retail|mall|store|shop|center|plaza/.test(t)) return 'retail';
  if (/church|ministry|worship/.test(t)) return 'religious';
  return 'commercial';
}

// A concrete opener a salesperson can lead with, grounded in the fire work.
function triggerFrom(desc: string): string {
  const t = (desc || '').toLowerCase();
  if (/alarm|modernization/.test(t)) return 'just did fire-alarm work; access-control and cameras tie in cleanly';
  if (/sprinkler|pump|pre-action/.test(t)) return 'sprinkler/pump work on site; a natural time to add cameras on the risk areas';
  if (/hood|suppression/.test(t)) return 'kitchen suppression service; cameras on back-of-house are an easy add';
  if (/inspection|tag|itm/.test(t)) return 'recurring inspection account; a truck is already on site regularly';
  return 'active fire-protection relationship';
}

export function buildPartnerCrossSell(): { live: boolean; count: number; leads: PartnerLead[] } {
  const db = getDb();
  const invoices = db.prepare(`SELECT customer, email, phone, amount, notes, issued_at FROM invoices`).all() as any[];
  const jobs = db.prepare(`SELECT customer, job_desc, completed_at FROM jobs`).all() as any[];
  const leads = db.prepare(`SELECT name, phone, address FROM leads`).all() as any[];
  const flags = db.prepare(`SELECT * FROM partner_flags ORDER BY created_at DESC`).all() as any[];

  const byName = new Map<string, any>();
  const touch = (name: string) => {
    const k = norm(name);
    if (!byName.has(k)) byName.set(k, { name, email: '', phone: '', amount: 0, invoices: 0, jobs: 0, lastJob: '', desc: '', address: '' });
    return byName.get(k);
  };

  for (const inv of invoices) {
    const r = touch(inv.customer);
    r.email ||= inv.email || '';
    r.phone ||= inv.phone || '';
    r.amount += Number(inv.amount || 0);
    r.invoices += 1;
    if (inv.notes) r.desc ||= inv.notes;
  }
  for (const j of jobs) {
    const r = touch(j.customer);
    r.jobs += 1;
    if (!r.lastJob || (j.completed_at && j.completed_at > r.lastJob)) r.lastJob = j.completed_at || '';
    r.desc ||= j.job_desc || '';
  }
  for (const l of leads) {
    if (!l.name) continue;
    const r = touch(l.name);
    r.phone ||= l.phone || '';
    r.address ||= l.address || '';
  }

  const out: PartnerLead[] = [];

  for (const r of byName.values()) {
    const rel = r.jobs >= 1 || r.invoices >= 2 ? 'strong' : r.invoices >= 1 ? 'normal' : 'new';
    const freq = r.jobs >= 2 ? 'high' : r.jobs >= 1 ? 'normal' : 'low';
    out.push({
      externalId: slug(r.name),
      company: r.name,
      contact: '',
      email: r.email,
      phone: r.phone,
      address: r.address,
      city: '',
      state: 'TX',
      propertyType: propertyType(r.name, r.desc),
      serviceType: r.desc || 'fire protection',
      fireRelationship: rel,
      onSiteFrequency: freq,
      lifetimeValue: Math.round(r.amount),
      lastJobAt: r.lastJob || '',
      triggerEvent: triggerFrom(r.desc),
      techFlagged: false,
      hasSecurityVendor: false,
      notes: `1st FP ${rel} relationship${r.amount ? `, ~$${Math.round(r.amount).toLocaleString()} of fire work` : ''}.`,
      source: '1st FP book',
    });
  }

  // Tech flags are the hottest leads: a person stood in the building and saw the gap.
  for (const f of flags) {
    out.push({
      externalId: 'flag-' + f.id,
      company: f.company,
      contact: f.contact || '',
      email: '',
      phone: '',
      address: f.address || '',
      city: '',
      state: 'TX',
      propertyType: propertyType(f.company, f.note || ''),
      serviceType: 'flagged on site',
      fireRelationship: 'strong',
      onSiteFrequency: 'high',
      lifetimeValue: 0,
      lastJobAt: f.created_at || '',
      triggerEvent: f.note || 'a 1st FP tech flagged this site for security',
      techFlagged: true,
      hasSecurityVendor: false,
      notes: `Flagged by ${f.flagged_by || 'a 1st FP tech'} on site: ${f.note || 'security gap noted'}.`,
      source: 'tech flag',
    });
  }

  return { live: integrationConnected('servicetrade'), count: out.length, leads: out };
}
