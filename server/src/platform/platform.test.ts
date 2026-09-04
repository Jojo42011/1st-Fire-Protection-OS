import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresHumanApproval } from './approvalPolicy';
import { ensurePlatformSchema } from './schema';
import { recordExternalResource, findExternalResource } from './idempotency';

test('risk policy gates external and high-risk actions', () => {
  assert.equal(requiresHumanApproval(0), false);
  assert.equal(requiresHumanApproval(2), false);
  assert.equal(requiresHumanApproval(3), true);
  assert.equal(requiresHumanApproval(4), true);
});

test('platform schema initializes idempotently', () => {
  assert.doesNotThrow(() => ensurePlatformSchema());
  assert.doesNotThrow(() => ensurePlatformSchema());
});

test('external resources are keyed by business idempotency key', () => {
  const key = `test:${Date.now()}:lead-form`;
  const first = recordExternalResource({
    clientId: 'test-client',
    system: 'meta',
    resourceType: 'lead_form',
    externalId: 'form-1',
    idempotencyKey: key,
  });
  const second = recordExternalResource({
    clientId: 'test-client',
    system: 'meta',
    resourceType: 'lead_form',
    externalId: 'form-2',
    idempotencyKey: key,
  });
  assert.equal(first.external_id, 'form-1');
  assert.equal(second.external_id, 'form-1');
  assert.equal((findExternalResource('meta', key, 'test-client') as any).external_id, 'form-1');
});
