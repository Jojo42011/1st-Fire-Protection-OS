import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';

process.env.DB_PATH = path.join(os.tmpdir(), `mgoffboard-test-${process.pid}.db`);
process.env.DEMO_MODE = 'off';
// Ensure Graph is NOT configured for this test so live calls are never attempted.
delete process.env.MS_GRAPH_TOKEN;
delete process.env.MS_GRAPH_TENANT;
delete process.env.MS_GRAPH_CLIENT_ID;
delete process.env.MS_GRAPH_CLIENT_SECRET;

import {
  isCloudExecutable, cloudActionLabel, graphOffboardConfigured, runCloudAction, offboardingPermissionCheck,
} from './msGraphOffboard';

test('the five cloud steps are recognized and labeled; DC/Exchange-only steps are not', () => {
  for (const ac of ['revoke_sessions', 'license_remove', 'autoreply_set', 'fwd_set', 'data_reassign']) {
    assert.equal(isCloudExecutable(ac), true, `${ac} is cloud-executable`);
    assert.ok(cloudActionLabel(ac), `${ac} has a label`);
  }
  // Convert-to-shared has no Graph API; AD steps run on the DC. Neither is server-runnable here.
  for (const ac of ['mbx_shared', 'ad_disable', 'groups_remove', 'ad_delete', 'hr_notify_safety']) {
    assert.equal(isCloudExecutable(ac), false, `${ac} is not cloud-executable`);
    assert.equal(cloudActionLabel(ac), null);
  }
});

test('with Graph not connected, every cloud action fails safe (never throws)', async () => {
  assert.equal(graphOffboardConfigured(), false);
  const req = { upn: 'jane@1stfpservices.com', name: 'Jane Tech', forward_to: 'boss@1stfpservices.com', manager_email: null };
  for (const ac of ['revoke_sessions', 'license_remove', 'autoreply_set', 'fwd_set', 'data_reassign']) {
    const r = await runCloudAction(ac, req);
    assert.equal(r.ok, false);
    assert.match(r.error || '', /not connected/i, `${ac} reports not connected`);
  }
});

test('permission check reports not-connected safely when Graph is off', async () => {
  const c = await offboardingPermissionCheck();
  assert.equal(c.connected, false);
  assert.equal(c.introspectable, false);
  assert.equal(c.allPresent, false);
  assert.deepEqual(c.roles, []);
});

test('an unknown action code is refused, not dispatched', async () => {
  const r = await runCloudAction('totally_made_up', { upn: 'x@y.com' });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /not a server-runnable cloud action/i);
});
