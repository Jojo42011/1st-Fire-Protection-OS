import { getDb } from '../db/index';
import { findNodeByLabel, boostNodeEdges, decayNodeEdges } from '../db/memory';

/**
 * THE CALIBRATION LEDGER: the Operator's metacognition.
 *
 * When the Operator stakes a claim (a gap it approved, a value line, a forecast) it is logged
 * as an OPEN prediction with a stated confidence and a measurable outcome. When the outcome is
 * knowable a human resolves it. Calibration (per-band hit rate, a Brier score, one confidence
 * discount) is computed ON READ from RESOLVED rows only, no background job, no synthetic
 * outcome. Small samples are flagged, never dressed as calibrated.
 *
 * The combined loop lives here too: a CONFIRMED resolution extra-reinforces the associations
 * around the finding's memory node; a REFUTED one decays them faster. So the association graph
 * wires what co-occurred AND turned out right. If the finding has no memory node, it skips
 * gracefully (it never invents a link).
 */

export type PredStatus = 'open' | 'confirmed' | 'refuted' | 'partial';

export interface Prediction {
  id: number;
  claim_kind: string | null;
  ref_id: string | null;
  statement: string | null;
  predicted_confidence: number;
  predicted_outcome: string | null;
  horizon_at: string | null;
  status: PredStatus;
  actual_outcome: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  sample: number;
  created_at: string;
}

/** confirmed = 1, partial = 0.5, refuted = 0. open / unknown = null (counts for nothing). */
export function outcomeValue(status: string): number | null {
  if (status === 'confirmed') return 1;
  if (status === 'partial') return 0.5;
  if (status === 'refuted') return 0;
  return null;
}

/** A finding carries no explicit confidence, so derive a sensible, honest default from severity. */
function confidenceFromSeverity(severity: string | null | undefined): number {
  switch (severity) {
    case 'critical':
      return 0.9;
    case 'high':
      return 0.8;
    case 'low':
      return 0.6;
    default:
      return 0.7; // medium / unknown
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * On approve/build, a finding stakes something: auto-create ONE open prediction from it.
 * Idempotent per finding (one prediction per ref_id). `at` is an ISO timestamp from the
 * request handler; the horizon is +30 days from it (no argless clock).
 */
export function createPredictionForFinding(findingId: number, at: string): Prediction | null {
  const db = getDb();
  const exists = db.prepare(`SELECT id FROM predictions WHERE ref_id = ?`).get(String(findingId));
  if (exists) return null;
  const f = db.prepare(`SELECT * FROM audit_findings WHERE id = ?`).get(findingId) as
    | { id: number; title: string; severity: string; value_line: string | null; cost_hint: string | null }
    | undefined;
  if (!f) return null;

  const conf = confidenceFromSeverity(f.severity);
  const horizon = new Date(Date.parse(at) + 30 * 86400000).toISOString();
  const outcome = f.value_line || f.cost_hint || 'the leak is measurably reduced';
  const kind = f.value_line ? 'value' : 'gap';
  const info = db
    .prepare(
      `INSERT INTO predictions (claim_kind, ref_id, statement, predicted_confidence, predicted_outcome, horizon_at, status, sample, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?)`
    )
    .run(kind, String(findingId), f.title, conf, outcome, horizon, at);
  return db.prepare(`SELECT * FROM predictions WHERE id = ?`).get(Number(info.lastInsertRowid)) as Prediction;
}

/** Human-gated resolution. Sets the outcome and closes the combined loop into memory. */
export function resolvePrediction(
  id: number,
  status: PredStatus,
  actualOutcome: string | undefined,
  resolvedBy: string | undefined,
  at: string
): { ok: boolean; error?: string } {
  if (!['confirmed', 'refuted', 'partial'].includes(status)) {
    return { ok: false, error: 'status must be confirmed|refuted|partial' };
  }
  const db = getDb();
  const p = db.prepare(`SELECT * FROM predictions WHERE id = ?`).get(id) as Prediction | undefined;
  if (!p) return { ok: false, error: 'no such prediction' };

  db.prepare(
    `UPDATE predictions SET status = ?, actual_outcome = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`
  ).run(status, actualOutcome || null, resolvedBy || 'human', at, id);

  // ── combined loop: wire what turned out right; fade what didn't ──
  try {
    if (p.ref_id && p.statement) {
      const nodeId = findNodeByLabel(p.statement, 'finding');
      if (nodeId) {
        if (status === 'confirmed') boostNodeEdges(nodeId, at);
        else if (status === 'refuted') decayNodeEdges(nodeId, at, 0.5);
        // partial: leave the associations as-is (neither confirmed nor refuted).
      }
    }
  } catch {
    /* memory feedback is best-effort; never fail the resolution on it */
  }
  return { ok: true };
}

export interface CalibrationBand {
  band: string;
  lo: number;
  hi: number;
  mid: number;
  n: number;
  hit_rate: number | null;
  lowSample: boolean;
}

export interface Calibration {
  bands: CalibrationBand[];
  brier: number | null;
  discount: number;
  counts: { open: number; resolved: number; confirmed: number; refuted: number; partial: number; total: number };
  resolved: Prediction[];
  open: Prediction[];
}

const BAND_EDGES: [number, number][] = [
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1.0],
];

/** The reliability curve + one honest headline, computed from RESOLVED predictions only. */
export function calibration(): Calibration {
  const db = getDb();
  const all = db.prepare(`SELECT * FROM predictions`).all() as Prediction[];
  const resolved = all.filter((p) => outcomeValue(p.status) !== null);
  const open = all.filter((p) => p.status === 'open');

  const bands: CalibrationBand[] = BAND_EDGES.map(([lo, hi]) => {
    const inb = resolved.filter(
      (p) => p.predicted_confidence >= lo && (hi >= 1 ? p.predicted_confidence <= hi : p.predicted_confidence < hi)
    );
    const n = inb.length;
    const hit = n ? inb.reduce((s, p) => s + (outcomeValue(p.status) as number), 0) / n : null;
    return { band: `${lo.toFixed(1)}-${hi.toFixed(1)}`, lo, hi, mid: (lo + hi) / 2, n, hit_rate: hit, lowSample: n > 0 && n < 3 };
  });

  const brier = resolved.length
    ? resolved.reduce((s, p) => {
        const o = outcomeValue(p.status) as number;
        return s + Math.pow(p.predicted_confidence - o, 2);
      }, 0) / resolved.length
    : null;

  // One confidence discount: measured hit rate vs stated confidence, smoothed toward 1.0
  // (perfectly calibrated) by K pseudo-observations so tiny samples do not swing it.
  const totalStated = resolved.reduce((s, p) => s + p.predicted_confidence, 0);
  const totalActual = resolved.reduce((s, p) => s + (outcomeValue(p.status) as number), 0);
  const meanStated = resolved.length ? totalStated / resolved.length : 0.7;
  const K = 3;
  const discountRaw = (totalActual + K * meanStated) / (totalStated + K * meanStated || 1);
  const discount = Math.round(clamp(discountRaw, 0.6, 1.15) * 100) / 100;

  const byResolved = [...resolved].sort((a, b) => (b.resolved_at || '').localeCompare(a.resolved_at || ''));
  const byHorizon = [...open].sort((a, b) => (a.horizon_at || '').localeCompare(b.horizon_at || ''));

  return {
    bands,
    brier: brier === null ? null : Math.round(brier * 100) / 100,
    discount,
    counts: {
      open: open.length,
      resolved: resolved.length,
      confirmed: resolved.filter((p) => p.status === 'confirmed').length,
      refuted: resolved.filter((p) => p.status === 'refuted').length,
      partial: resolved.filter((p) => p.status === 'partial').length,
      total: all.length,
    },
    resolved: byResolved,
    open: byHorizon,
  };
}
