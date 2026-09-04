import { getDb } from '../db';
import { ensurePlatformSchema } from './schema';

export interface OutcomeMeasurement {
  clientId?: string;
  initiativeKey: string;
  metricKey: string;
  baseline?: number;
  target?: number;
  actual?: number;
  economicValue?: number;
  confidence?: number;
  periodStart?: string;
  periodEnd?: string;
  evidence?: unknown;
  verifiedBy?: string;
}

export function recordOutcome(input: OutcomeMeasurement): number {
  ensurePlatformSchema();
  const result = getDb().prepare(`
    INSERT INTO measured_outcomes
      (client_id, initiative_key, metric_key, baseline, target, actual, economic_value,
       confidence, period_start, period_end, evidence_json, verified_by, verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)
  `).run(
    input.clientId || '1stfp',
    input.initiativeKey,
    input.metricKey,
    input.baseline ?? null,
    input.target ?? null,
    input.actual ?? null,
    input.economicValue ?? null,
    input.confidence ?? null,
    input.periodStart ?? null,
    input.periodEnd ?? null,
    input.evidence === undefined ? null : JSON.stringify(input.evidence),
    input.verifiedBy ?? null,
    input.verifiedBy ?? null,
  );
  return Number(result.lastInsertRowid);
}
