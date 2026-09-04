import { getDb } from '../db/index';
import { canonicalOffice } from '../os/office';

/**
 * Per-office letterhead branding for proposals: each branch's own LLC name plus its street address and
 * phone. The LLC name is derived live from BambooHR (the employees' office string is the legal entity,
 * e.g. "1st FP Houston, LLC (HOU)"), so it stays correct as HR changes it; the addresses come from the
 * company website and rarely change, so they live here as an editable map keyed by canonical office.
 */

export interface OfficeBranding { office: string; llc: string; street: string; cityStateZip: string; phone: string; }

// Street address + phone per branch (from 1stfpservices.com/contact).
const ADDR: Record<string, { street: string; cityStateZip: string; phone: string }> = {
  services:          { street: '231 E Rhapsody Dr',              cityStateZip: 'San Antonio, TX 78216',   phone: '210-377-3473' },
  austin:            { street: '12414 Laws Rd',                  cityStateZip: 'Buda, TX 78610',           phone: '512-312-9768' },
  waco:              { street: '12772 Chapel Rd',                cityStateZip: 'Lorena, TX 76655',         phone: '254-327-3744' },
  'college-station': { street: '12948 Tonkaway Lake Rd, Ste 326', cityStateZip: 'College Station, TX 77845', phone: '979-978-6563' },
  houston:           { street: '25003 Pitkin Rd, D300',          cityStateZip: 'Spring, TX 77386',         phone: '346-372-8684' },
  laredo:            { street: '6318 Krone Ln, Suite 4',         cityStateZip: 'Laredo, TX 78041',         phone: '210-387-0182' },
  mcallen:           { street: '2053 Industrial Dr',             cityStateZip: 'McAllen, TX 78504',        phone: '956-682-3473' },
  lubbock:           { street: '8807 CR 6820, Ste 2',            cityStateZip: 'Lubbock, TX 79407',        phone: '806-216-7634' },
  extinguishers:     { street: '12414 Laws Rd, #2',             cityStateZip: 'Buda, TX 78610',           phone: '210-377-3473' },
  'corpus-christi':  { street: '4410 Dillion Ln, Suite 20',      cityStateZip: 'Corpus Christi, TX 78415', phone: '361-960-5503' },
};

// Fallback legal-entity names by office, used only when BambooHR has no office string for that branch.
const DEFAULT_LLC: Record<string, string> = {
  services: '1st FP Services, LLC', austin: '1st FP Austin, LLC', houston: '1st FP Houston, LLC',
  mcallen: '1st FP McAllen, LLC', waco: '1st FP Waco, LLC', laredo: '1st FP Laredo, LLC',
  lubbock: '1st FP Lubbock, LLC', 'college-station': '1st FP College Station, LLC',
  extinguishers: '1st FP Extinguishers, LLC', management: '1st FP Sprinkler Companies, LLC',
  asds: 'Austin Sprinkler Design Services LLC',
};

const DEFAULT_ADDR = ADDR.services; // San Antonio HQ is the fallback address.
const cleanLlc = (s: string): string => String(s || '').replace(/\s*\([A-Za-z0-9]+\)\s*$/, '').replace(/\s{2,}/g, ' ').trim();

/** The BambooHR office string (the LLC name) most employees at this office carry. Live source of truth. */
function bambooLlc(key: string): string | null {
  if (!key) return null;
  const rows = getDb().prepare(
    `SELECT office, COUNT(*) c FROM employees WHERE office IS NOT NULL AND office != '' GROUP BY office ORDER BY c DESC`
  ).all() as { office: string; c: number }[];
  for (const r of rows) if (canonicalOffice(r.office) === key && /llc/i.test(r.office)) return cleanLlc(r.office);
  return null;
}

export function officeBranding(officeRaw: string): OfficeBranding {
  const key = officeRaw ? (canonicalOffice(officeRaw) || '') : '';
  const llc = bambooLlc(key) || DEFAULT_LLC[key] || '1st Fire Protection Services, LLC';
  const a = ADDR[key] || DEFAULT_ADDR;
  return { office: key, llc, street: a.street, cityStateZip: a.cityStateZip, phone: a.phone };
}
