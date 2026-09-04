import { getDb } from '../db';
import { ensurePlatformSchema } from './schema';

export interface ExternalResourceInput {
  clientId?: string;
  system: string;
  resourceType: string;
  externalId: string;
  idempotencyKey: string;
  workflowRunId?: string;
  status?: string;
  metadata?: unknown;
}

export function findExternalResource(system: string, idempotencyKey: string, clientId = '1stfp') {
  ensurePlatformSchema();
  return getDb().prepare(`
    SELECT * FROM external_resources
    WHERE client_id = ? AND system = ? AND idempotency_key = ?
  `).get(clientId, system, idempotencyKey) as Record<string, unknown> | undefined;
}

export function recordExternalResource(input: ExternalResourceInput) {
  ensurePlatformSchema();
  const clientId = input.clientId || '1stfp';
  const existing = findExternalResource(input.system, input.idempotencyKey, clientId);
  if (existing) return existing;

  getDb().prepare(`
    INSERT INTO external_resources
      (client_id, system, resource_type, external_id, idempotency_key, workflow_run_id, status, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clientId,
    input.system,
    input.resourceType,
    input.externalId,
    input.idempotencyKey,
    input.workflowRunId || null,
    input.status || 'active',
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  );

  return findExternalResource(input.system, input.idempotencyKey, clientId)!;
}

/** Execute a create-side effect at most once according to business intent. */
export async function createExternalResourceOnce<T extends { id: string }>(
  input: Omit<ExternalResourceInput, 'externalId'>,
  create: () => Promise<T>,
): Promise<{ resource: T | Record<string, unknown>; reused: boolean }> {
  const clientId = input.clientId || '1stfp';
  const existing = findExternalResource(input.system, input.idempotencyKey, clientId);
  if (existing) return { resource: existing, reused: true };

  const created = await create();
  recordExternalResource({ ...input, externalId: created.id });
  return { resource: created, reused: false };
}
