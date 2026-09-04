/**
 * NFPA inspection / testing / maintenance (ITM) reference checklists.
 *
 * These are the standard field checklists 1st Fire Protection runs against the three system families
 * the company services: portable fire extinguishers (NFPA 10), water-based sprinkler/standpipe systems
 * (NFPA 25), and fire alarm systems (NFPA 72). The data drives the inspection module: an inspector
 * picks a system and a service interval, and the app renders exactly the line items due at that interval
 * so nothing is missed and the printed report reads like a real AHJ inspection form.
 *
 * Source of the intervals and line items: the NFPA standards as summarized in the Essential
 * (withessential.com) NFPA compliance guides. Intervals reflect the base code; a stricter local AHJ
 * always wins, so the report notes that the authority having jurisdiction may require more.
 *
 * NOT legal advice and NOT a substitute for the adopted edition of the standard. Verify against the
 * edition your AHJ enforces before relying on a frequency in the field.
 */

export type ItmFreq =
  | 'monthly' | 'quarterly' | 'semiannual' | 'annual'
  | 'weekly' | 'daily'
  | '3-year' | '5-year' | 'multi-year';

export type ItmKind = 'inspect' | 'test' | 'maintain';

export interface ChecklistItem {
  /** stable id, unique within a template; used as the answer key on a saved inspection */
  key: string;
  text: string;
  freq: ItmFreq;
  kind: ItmKind;
  /** section / note, e.g. "NFPA 10 §7.2" */
  ref?: string;
}

export interface NfpaTemplate {
  code: 'NFPA10' | 'NFPA25' | 'NFPA72';
  /** short slug used on the wire and in the DB */
  system: 'extinguisher' | 'sprinkler' | 'alarm';
  title: string;
  /** what the inspector is signing off on, printed under the report title */
  standard: string;
  /** the service intervals an inspector can run for this system, in cadence order */
  intervals: ItmFreq[];
  items: ChecklistItem[];
  /** longer-cycle life items shown as a reference table (agent/hydro/sensitivity), not per-visit checks */
  cycles?: { label: string; detail: string }[];
}

const FREQ_ORDER: ItmFreq[] = ['daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'annual', '3-year', '5-year', 'multi-year'];

/* ─────────────────────────── NFPA 10 · Portable fire extinguishers ─────────────────────────── */
const NFPA10: NfpaTemplate = {
  code: 'NFPA10', system: 'extinguisher', title: 'Fire extinguisher inspection', standard: 'NFPA 10 · Standard for Portable Fire Extinguishers',
  intervals: ['monthly', 'annual'],
  items: [
    // Monthly visual (NFPA 10 §7.2) — building staff may perform; no certification required.
    { key: 'e_location', text: 'Extinguisher is in its designated location', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §7.2' },
    { key: 'e_visible', text: 'Unit is visible or directional signage is present', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §7.2' },
    { key: 'e_access', text: 'Access is not blocked by equipment or storage', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §7.2' },
    { key: 'e_gauge', text: 'Pressure gauge reads in the operable (green) range', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §7.2' },
    { key: 'e_fullness', text: 'Unit feels full when hefted or weighed (CO2: verify by weight)', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §7.2' },
    { key: 'e_seals', text: 'Safety seals and tamper indicators are intact', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §7.2' },
    { key: 'e_condition', text: 'No physical damage, corrosion, leakage, or clogged nozzle', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §7.2' },
    { key: 'e_labels', text: 'Operating instructions / HMIS label legible and facing outward', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §7.2' },
    { key: 'e_mount', text: 'Mounted at proper height (top ≤5 ft for ≤40 lb; ≤3.5 ft for >40 lb; ≥4 in clearance)', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §6.1.3' },
    { key: 'e_wheeled', text: 'Wheeled units: tires, wheels, hoses and nozzles functional', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §7.2' },
    { key: 'e_pushtest', text: 'Non-rechargeable units: push-to-test indicator checked', freq: 'monthly', kind: 'inspect', ref: 'NFPA 10 §7.2' },
    // Annual maintenance (NFPA 10 §7.3) — certified technician with the manufacturer service manual.
    { key: 'e_ext_exam', text: 'Thorough external examination of shell, valve and hardware', freq: 'annual', kind: 'maintain', ref: 'NFPA 10 §7.3' },
    { key: 'e_mech', text: 'Mechanical parts, expelling means and agent examined', freq: 'annual', kind: 'maintain', ref: 'NFPA 10 §7.3' },
    { key: 'e_hose', text: 'CO2: annual hose conductivity test performed', freq: 'annual', kind: 'test', ref: 'NFPA 10 §7.4' },
    { key: 'e_reseal', text: 'New tamper seals installed after service', freq: 'annual', kind: 'maintain', ref: 'NFPA 10 §7.3' },
    { key: 'e_tag', text: 'Service tag applied (month, year, technician, company)', freq: 'annual', kind: 'maintain', ref: 'NFPA 10 §7.3.3' },
  ],
  cycles: [
    { label: 'Dry chemical (stored-pressure ABC/BC)', detail: 'Internal exam 6 yr · hydrostatic test 12 yr' },
    { label: 'Clean agent / Halon / dry powder', detail: 'Internal exam 6 yr · hydrostatic test 12 yr' },
    { label: 'Carbon dioxide (CO2)', detail: 'Internal exam 5 yr · hydrostatic test 5 yr' },
    { label: 'Wet chemical (Class K)', detail: 'Internal exam 5 yr · hydrostatic test 5 yr' },
    { label: 'Water / water mist', detail: 'Internal exam 5 yr · hydrostatic test 5 yr' },
    { label: 'AFFF / FFFP foam', detail: 'Internal exam 3 yr · hydrostatic test 5 yr' },
    { label: 'Cartridge-operated dry chemical', detail: 'Internal exam annually · hydrostatic test 12 yr' },
    { label: 'Non-rechargeable (disposable)', detail: 'Remove from service 12 yr from manufacture date' },
  ],
};

/* ─────────────────────── NFPA 25 · Water-based fire protection systems ─────────────────────── */
const NFPA25: NfpaTemplate = {
  code: 'NFPA25', system: 'sprinkler', title: 'Sprinkler / standpipe ITM', standard: 'NFPA 25 · Inspection, Testing and Maintenance of Water-Based Fire Protection Systems',
  intervals: ['weekly', 'monthly', 'quarterly', 'annual', '5-year'],
  items: [
    // Weekly
    { key: 's_fp_noflow_d', text: 'Fire pump no-flow (churn) test — diesel, 30 min', freq: 'weekly', kind: 'test', ref: 'NFPA 25 §8.3' },
    { key: 's_cv_locked', text: 'Control valves locked/sealed in correct position', freq: 'weekly', kind: 'inspect', ref: 'NFPA 25 §13.3' },
    // Monthly
    { key: 's_fp_noflow_e', text: 'Fire pump no-flow (churn) test — electric, 10 min', freq: 'monthly', kind: 'test', ref: 'NFPA 25 §8.3' },
    { key: 's_cv_supervised', text: 'Control valves (electronically supervised) in correct position', freq: 'monthly', kind: 'inspect', ref: 'NFPA 25 §13.3' },
    { key: 's_gauge_wet', text: 'Wet-system gauges show normal water pressure', freq: 'monthly', kind: 'inspect', ref: 'NFPA 25 §5.2' },
    { key: 's_air_dry', text: 'Dry/preaction system air pressure normal', freq: 'monthly', kind: 'inspect', ref: 'NFPA 25 §5.2' },
    // Quarterly
    { key: 's_alarm_flow', text: 'Waterflow alarm device test', freq: 'quarterly', kind: 'test', ref: 'NFPA 25 §5.3' },
    { key: 's_supervisory', text: 'Valve supervisory / tamper switch test', freq: 'quarterly', kind: 'test', ref: 'NFPA 25 §13.3' },
    { key: 's_hydrant_fdc', text: 'Fire department connection (FDC) inspected', freq: 'quarterly', kind: 'inspect', ref: 'NFPA 25 §13.7' },
    // Annual
    { key: 's_heads', text: 'Sprinkler heads inspected (no corrosion, loading, paint, obstruction)', freq: 'annual', kind: 'inspect', ref: 'NFPA 25 §5.2' },
    { key: 's_maindrain', text: 'Main drain test performed and static/residual recorded', freq: 'annual', kind: 'test', ref: 'NFPA 25 §13.2.5' },
    { key: 's_fp_flow', text: 'Fire pump full-flow performance test', freq: 'annual', kind: 'test', ref: 'NFPA 25 §8.3.3' },
    { key: 's_fp_maint', text: 'Fire pump maintenance (oil, filters, batteries, connections)', freq: 'annual', kind: 'maintain', ref: 'NFPA 25 §8.5' },
    { key: 's_antifreeze', text: 'Antifreeze solution freeze-point tested', freq: 'annual', kind: 'test', ref: 'NFPA 25 §5.3.4' },
    { key: 's_hanger', text: 'Pipe, hangers and bracing inspected for condition', freq: 'annual', kind: 'inspect', ref: 'NFPA 25 §5.2' },
    // 5-year
    { key: 's_internal', text: 'Internal pipe assessment (obstruction / corrosion)', freq: '5-year', kind: 'inspect', ref: 'NFPA 25 §14.2' },
    { key: 's_standpipe_flow', text: 'Standpipe flow test', freq: '5-year', kind: 'test', ref: 'NFPA 25 §6.3' },
    { key: 's_fdc_hydro', text: 'FDC / standpipe hydrostatic test', freq: '5-year', kind: 'test', ref: 'NFPA 25 §6.3.2' },
    { key: 's_gauge_replace', text: 'Gauges replaced or calibrated', freq: '5-year', kind: 'maintain', ref: 'NFPA 25 §5.3.2' },
  ],
  cycles: [
    { label: 'Dry-system full trip test', detail: 'Full-flow trip test every 3 yr' },
    { label: 'Fast-response sprinklers', detail: 'Sample test / replace at 20 yr, then every 10 yr' },
    { label: 'Standard-response sprinklers', detail: 'Sample test / replace at 50 yr, then every 10 yr' },
    { label: 'Dry-pendent / ESFR / CMSA sprinklers', detail: 'Sample test / replace at 20 yr' },
    { label: 'Extra-high / harsh-environment sprinklers', detail: 'Sample test every 5 yr' },
  ],
};

/* ───────────────────────────── NFPA 72 · Fire alarm systems ───────────────────────────── */
const NFPA72: NfpaTemplate = {
  code: 'NFPA72', system: 'alarm', title: 'Fire alarm ITM', standard: 'NFPA 72 · National Fire Alarm and Signaling Code',
  intervals: ['weekly', 'quarterly', 'semiannual', 'annual'],
  items: [
    // Weekly (inspection of control equipment in buildings without constant monitoring)
    { key: 'a_ctrl_weekly', text: 'Control equipment inspected — fuses, LEDs, power supply, trouble signals (unmonitored premises)', freq: 'weekly', kind: 'inspect', ref: 'NFPA 72 Table 14.3.1' },
    // Quarterly
    { key: 'a_radiant', text: 'Radiant-energy (flame / spark-ember) detectors inspected', freq: 'quarterly', kind: 'inspect', ref: 'NFPA 72 Table 14.3.1' },
    { key: 'a_video', text: 'Video image smoke / fire detectors inspected', freq: 'quarterly', kind: 'inspect', ref: 'NFPA 72 Table 14.3.1' },
    // Semiannual
    { key: 'a_init_insp', text: 'Initiating devices inspected — smoke, heat, duct detectors', freq: 'semiannual', kind: 'inspect', ref: 'NFPA 72 Table 14.3.1' },
    { key: 'a_pull_insp', text: 'Manual pull stations inspected', freq: 'semiannual', kind: 'inspect', ref: 'NFPA 72 Table 14.3.1' },
    { key: 'a_notif_insp', text: 'Notification appliances inspected — horns, strobes', freq: 'semiannual', kind: 'inspect', ref: 'NFPA 72 Table 14.3.1' },
    { key: 'a_waterflow', text: 'Waterflow devices inspected AND tested', freq: 'semiannual', kind: 'test', ref: 'NFPA 72 (2025) Table 14.4.3.2' },
    { key: 'a_valve_sup', text: 'Control valve supervisory switches inspected AND tested', freq: 'semiannual', kind: 'test', ref: 'NFPA 72 (2025) Table 14.4.3.2' },
    // Annual
    { key: 'a_ctrl_test', text: 'Control panel / control equipment functional test', freq: 'annual', kind: 'test', ref: 'NFPA 72 Table 14.4.3.2' },
    { key: 'a_batt', text: 'Secondary power (batteries) load / capacity test', freq: 'annual', kind: 'test', ref: 'NFPA 72 §14.4.5' },
    { key: 'a_init_test', text: 'Initiating devices functional test — every device actuated', freq: 'annual', kind: 'test', ref: 'NFPA 72 Table 14.4.3.2' },
    { key: 'a_pull_test', text: 'Manual pull stations functional test', freq: 'annual', kind: 'test', ref: 'NFPA 72 Table 14.4.3.2' },
    { key: 'a_notif_test', text: 'Notification appliances functional test (audible/visible)', freq: 'annual', kind: 'test', ref: 'NFPA 72 Table 14.4.3.2' },
    { key: 'a_comm', text: 'Off-premises signal transmission / communicator test', freq: 'annual', kind: 'test', ref: 'NFPA 72 §14.4.4' },
    { key: 'a_co', text: 'CO detectors functional test (per manufacturer)', freq: 'annual', kind: 'test', ref: 'NFPA 72 / NFPA 720' },
  ],
  cycles: [
    { label: 'Smoke detector sensitivity', detail: 'Test within 1 yr of install, then every alternate (2nd) year' },
    { label: 'Sealed lead-acid batteries', detail: 'Replace within 4 yr of manufacture date' },
  ],
};

const TEMPLATES: Record<string, NfpaTemplate> = { extinguisher: NFPA10, sprinkler: NFPA25, alarm: NFPA72 };

/** The three system families the inspection module supports, for the picker. */
export function inspectionSystems(): { system: string; code: string; title: string; standard: string; intervals: ItmFreq[] }[] {
  return Object.values(TEMPLATES).map((t) => ({ system: t.system, code: t.code, title: t.title, standard: t.standard, intervals: t.intervals }));
}

/** Full template for a system slug (extinguisher | sprinkler | alarm). */
export function templateFor(system: string): NfpaTemplate | null {
  return TEMPLATES[String(system || '').toLowerCase()] || null;
}

/**
 * The line items due for a system at a chosen interval. An interval includes every item at that cadence
 * and everything more frequent (an annual visit also covers the monthly and quarterly checks), which is
 * how a real ITM visit rolls up. Pass no interval to get the whole checklist.
 */
export function checklistFor(system: string, interval?: string): ChecklistItem[] {
  const t = templateFor(system);
  if (!t) return [];
  if (!interval) return t.items.slice();
  const cut = FREQ_ORDER.indexOf(interval as ItmFreq);
  if (cut < 0) return t.items.slice();
  return t.items.filter((it) => FREQ_ORDER.indexOf(it.freq) <= cut);
}
