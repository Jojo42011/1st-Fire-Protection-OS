import { getDb } from '../db/index';
import { findItem } from './priceBook';
import { getQuote, addLine, QuoteWithLines } from './quotesBuilder';

/**
 * Phase 2: parametric auto-takeoff. Turn a handful of project parameters (area, hazard, system type,
 * stories) into a priced bill of materials on a quote, using standard fire-protection rules of thumb.
 * This is the budget / ROM takeoff an estimator does by hand: it seeds a populated, priced quote from
 * a few inputs instead of a blank one, and every generated line stays fully editable.
 *
 * Per-each device/head quantities try to price from the office price book (real vendor cost + labor);
 * pipe, assemblies and design fall back to curated ballpark costs, because the book prices pipe per
 * 100 ft and assemblies vary, so auto-matching them would risk silent mispricing. Nothing here is an
 * engineered design: a real hydraulic calc and a stamped drawing still govern the final numbers.
 */

export interface TakeoffParams { sf: number; hazard: string; system_type: string; stories: number; type: string; }
export interface TakeoffLine { name: string; unit: string; qty: number; cost: number; hrs: number; cat: string; sku: string | null; basis: string; }

/** NFPA 13 coverage per sprinkler (sq ft), by hazard classification. */
function coveragePerHead(hazard: string): number {
  const h = String(hazard || '').toLowerCase();
  if (h.includes('extra')) return 100;
  if (h.includes('ordinary') || h.includes('group 2') || h.includes('og2')) return 130;
  if (h.includes('light')) return 200;
  return 150; // unknown / mixed -> a middle-of-the-road assumption
}

const ceilDiv = (a: number, b: number) => Math.max(0, Math.ceil((Number(a) || 0) / b));

/** A component: fixed fallback cost/hrs, plus optional price-book keywords to price it live (per-each only). */
function line(office: string, def: { name: string; unit: string; qty: number; cost: number; hrs: number; cat: string; basis: string; match?: string[] }): TakeoffLine {
  let cost = def.cost, hrs = def.hrs, sku: string | null = null;
  if (def.match && def.unit === 'ea') {
    const it = findItem(office, def.match, 'ea');
    if (it && (it.cost != null)) { cost = Number(it.cost) || def.cost; hrs = Number(it.labor_hrs) || def.hrs; sku = it.sku; }
  }
  return { name: def.name, unit: def.unit, qty: def.qty, cost, hrs, cat: def.cat, sku, basis: def.basis };
}

function sprinklerLines(office: string, p: TakeoffParams): TakeoffLine[] {
  const sf = Math.max(0, Number(p.sf) || 0);
  if (!sf) return [];
  const cov = coveragePerHead(p.hazard);
  const heads = ceilDiv(sf, cov);
  const side = Math.ceil(Math.sqrt(sf));
  const stories = Math.max(1, Number(p.stories) || 1);
  const branchLf = heads * 12;                 // ~12 ft average branch-line run per head
  const mainLf = side * 2 * stories;           // two mains across the footprint per floor
  const risers = Math.max(1, ceilDiv(sf, 52000));
  const wet = !String(p.system_type || '').toLowerCase().includes('dry');
  const out: TakeoffLine[] = [
    line(office, { name: `Sprinkler heads (${p.hazard || 'mixed'} hazard, 1 per ${cov} sf)`, unit: 'ea', qty: heads, cost: 9, hrs: 0.5, cat: 'Sprinkler', basis: `${sf.toLocaleString()} sf ÷ ${cov} sf/head`, match: ['sprinkler head', 'pendent', 'upright'] }),
    line(office, { name: 'Branch-line pipe & fittings (1"-1¼")', unit: 'lf', qty: branchLf, cost: 1.8, hrs: 0.06, cat: 'Pipe', basis: `${heads} heads × 12 ft` }),
    line(office, { name: 'Cross-main pipe (2½"-4")', unit: 'lf', qty: mainLf, cost: 6.5, hrs: 0.12, cat: 'Pipe', basis: `${side} ft side × 2 runs × ${stories} floor(s)` }),
    line(office, { name: 'Fittings & couplings', unit: 'ea', qty: heads * 2, cost: 4, hrs: 0.1, cat: 'Fittings', basis: '2 per head' }),
    line(office, { name: 'Pipe hangers & seismic bracing', unit: 'ea', qty: ceilDiv(branchLf + mainLf, 12), cost: 3.5, hrs: 0.15, cat: 'Hangers', basis: 'pipe ÷ 12 ft max spacing' }),
    line(office, { name: 'Riser / alarm-valve trim assembly', unit: 'ea', qty: risers, cost: 950, hrs: 10, cat: 'Riser', basis: `1 per ~52,000 sf system` }),
    line(office, { name: 'Inspector test & main drain assembly', unit: 'ea', qty: risers, cost: 120, hrs: 2, cat: 'Riser', basis: '1 per riser' }),
    line(office, { name: 'Fire department connection (FDC)', unit: 'ea', qty: 1, cost: 350, hrs: 4, cat: 'Riser', basis: '1 per building' }),
    line(office, { name: 'Hydraulic design, calcs & permit', unit: 'ls', qty: 1, cost: 0, hrs: 12, cat: 'Design', basis: 'engineering + AHJ submittal' }),
  ];
  if (wet) out.splice(6, 0, line(office, { name: 'Backflow preventer assembly', unit: 'ea', qty: 1, cost: 1800, hrs: 8, cat: 'Riser', basis: 'wet system, 1 per service' }));
  return out;
}

function alarmLines(office: string, p: TakeoffParams): TakeoffLine[] {
  const sf = Math.max(0, Number(p.sf) || 0);
  if (!sf) return [];
  const stories = Math.max(1, Number(p.stories) || 1);
  const smokes = ceilDiv(sf, 900);
  const heats = ceilDiv(sf, 3000);
  const pulls = Math.max(2, stories * 2);
  const horns = ceilDiv(sf, 1600);
  const ducts = ceilDiv(sf, 25000);
  const devices = smokes + heats + pulls + horns;
  return [
    line(office, { name: 'Fire alarm control panel (FACP)', unit: 'ea', qty: 1, cost: 1400, hrs: 12, cat: 'Alarm', basis: '1 per building', match: ['control panel', 'facp'] }),
    line(office, { name: 'Smoke detectors (1 per 900 sf)', unit: 'ea', qty: smokes, cost: 45, hrs: 0.75, cat: 'Alarm', basis: `${sf.toLocaleString()} sf ÷ 900`, match: ['smoke detector'] }),
    line(office, { name: 'Heat detectors', unit: 'ea', qty: heats, cost: 38, hrs: 0.6, cat: 'Alarm', basis: `${sf.toLocaleString()} sf ÷ 3,000`, match: ['heat detector'] }),
    line(office, { name: 'Manual pull stations', unit: 'ea', qty: pulls, cost: 42, hrs: 0.6, cat: 'Alarm', basis: `2 per floor × ${stories}`, match: ['pull station'] }),
    line(office, { name: 'Horn/strobe notification appliances', unit: 'ea', qty: horns, cost: 55, hrs: 0.7, cat: 'Alarm', basis: `${sf.toLocaleString()} sf ÷ 1,600`, match: ['horn strobe', 'notification', 'strobe'] }),
    line(office, { name: 'Duct smoke detectors', unit: 'ea', qty: ducts, cost: 190, hrs: 2, cat: 'Alarm', basis: `1 per ~25,000 sf (AHU)`, match: ['duct detector'] }),
    line(office, { name: 'Fire alarm wire (FPLR/FPL)', unit: 'lf', qty: devices * 45, cost: 0.45, hrs: 0.02, cat: 'Alarm', basis: `${devices} devices × 45 ft` }),
    line(office, { name: 'Battery / secondary power', unit: 'ea', qty: 1, cost: 120, hrs: 1, cat: 'Alarm', basis: '24-hr standby' }),
    line(office, { name: 'Programming, test & AHJ acceptance', unit: 'ls', qty: 1, cost: 0, hrs: 10, cat: 'Design', basis: 'commissioning + inspection' }),
  ];
}

/** Compute (but do not persist) the takeoff lines for a set of parameters and a job type. */
export function computeTakeoff(office: string, p: TakeoffParams): TakeoffLine[] {
  const t = String(p.type || '').toLowerCase();
  const wantAlarm = t.includes('alarm') || t.includes('both');
  const wantSprinkler = t.includes('sprinkler') || t.includes('both') || (!t.includes('alarm'));
  const out: TakeoffLine[] = [];
  if (wantSprinkler) out.push(...sprinklerLines(office, p));
  if (wantAlarm) out.push(...alarmLines(office, p));
  return out;
}

/**
 * Generate the takeoff onto a quote. Reads the quote's own parameters (with optional overrides), writes
 * one line per component, and returns the recomputed quote. `replace` clears existing lines first (a
 * re-run); otherwise the takeoff is appended.
 */
export function generateTakeoff(quoteId: number, opts: { replace?: boolean; sf?: number; hazard?: string; system_type?: string; stories?: number } = {}): (QuoteWithLines & { generated: number }) | null {
  const d = getQuote(quoteId);
  if (!d) return null;
  const q = d.quote;
  const params: TakeoffParams = {
    sf: opts.sf != null ? Number(opts.sf) : (Number(q.sf) || 0),
    hazard: opts.hazard != null ? String(opts.hazard) : (q.hazard || ''),
    system_type: opts.system_type != null ? String(opts.system_type) : (q.system_type || ''),
    stories: opts.stories != null ? Number(opts.stories) : (Number(q.stories) || 1),
    type: q.type || 'Fire Sprinkler',
  };
  const lines = computeTakeoff(q.office, params);
  if (!lines.length) return null;
  const db = getDb();
  if (opts.replace) db.prepare(`DELETE FROM est_quote_lines WHERE quote_id = ?`).run(quoteId);
  // Persist any parameter overrides back onto the quote so the header reflects what was estimated.
  const sets: string[] = []; const args: any[] = [];
  for (const [k, v] of Object.entries({ sf: opts.sf, hazard: opts.hazard, system_type: opts.system_type, stories: opts.stories })) {
    if (v !== undefined && v !== '' && v !== null) { sets.push(`${k} = ?`); args.push(k === 'sf' || k === 'stories' ? Number(v) : v); }
  }
  if (sets.length) { args.push(quoteId); db.prepare(`UPDATE est_quotes SET ${sets.join(', ')} WHERE id = ?`).run(...args); }
  const tx = db.transaction(() => {
    for (const l of lines) addLine(quoteId, { name: l.name, unit: l.unit, cat: l.cat, qty: l.qty, cost: l.cost, hrs: l.hrs, sku: l.sku || undefined });
  });
  tx();
  const out = getQuote(quoteId)!;
  return { ...out, generated: lines.length };
}
