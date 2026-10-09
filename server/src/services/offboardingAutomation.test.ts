import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-offb-auto-test-${process.pid}.db`);
process.env.MS_GRAPH_TOKEN = 'test-token';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { createOffboarding } from './offboardingAgent';
import { autoReassignOneDrive } from './offboardingAutomation';

initDb();
const db = getDb();
db.exec(`DELETE FROM offboarding_items; DELETE FROM offboarding_requests;`);

let calls: { url: string; method: string; body: any }[] = [];
let driveStatus = 200;
(globalThis as any).fetch = async (url: string, init: any = {}) => {
  const method = (init.method || 'GET').toUpperCase();
  calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
  const json = (status: number, j: any) => ({ ok: status < 300, status, json: async () => j, text: async () => JSON.stringify(j) });
  if (/\/drive\/root\/invite$/.test(url)) return json(200, { value: [] });
  if (/\/drive\?/.test(url)) return json(driveStatus, driveStatus === 200 ? { id: 'd1', webUrl: 'https://1stfp-my.sharepoint.com/personal/lee_gone' } : { error: 'nope' });
  if (/\/sendMail$/.test(url)) return json(202, {});
  if (/\/users\/[^/?]+\?\$select=id$/.test(url)) return json(200, { id: 'u1' });
  return json(404, {});
};

test('on the last day the manager gets the OneDrive, a link by email, and the step closes itself', async () => {
  const { request } = createOffboarding({ name: 'Lee Gone', upn: 'lee.gone@1stfpservices.com', manager_email: 'boss@1stfpservices.com', termination_date: '2026-10-01' });
  calls = [];
  const out = await autoReassignOneDrive(new Date('2026-10-02T15:00:00Z'));
  assert.equal(out.done, 1);
  const invite = calls.find((c) => /invite$/.test(c.url))!;
  assert.deepEqual(invite.body.recipients, [{ email: 'boss@1stfpservices.com' }]);
  assert.equal(invite.body.sendInvitation, false);
  const mail = calls.find((c) => /sendMail$/.test(c.url))!;
  assert.match(JSON.stringify(mail.body), /lee_gone/);
  assert.match(JSON.stringify(mail.body), /boss@1stfpservices\.com/);
  const item = db.prepare(`SELECT status, decided_by FROM offboarding_items WHERE request_id = ? AND action_code = 'data_reassign'`).get(request.id) as any;
  assert.deepEqual(item, { status: 'done', decided_by: 'automation' });
  calls = [];
  assert.equal((await autoReassignOneDrive(new Date('2026-10-02T16:00:00Z'))).done, 0, 'only once');
});

test('not before the last day, and a failure is retried at most once a day', async () => {
  const { request } = createOffboarding({ name: 'Future Leaver', upn: 'future@1stfpservices.com', manager_email: 'boss@1stfpservices.com', termination_date: '2026-12-01' });
  calls = [];
  assert.equal((await autoReassignOneDrive(new Date('2026-10-02T15:00:00Z'))).done, 0);
  assert.equal(calls.length, 0, 'nothing touched before their last day');
  driveStatus = 404;
  const first = await autoReassignOneDrive(new Date('2026-12-01T15:00:00Z'));
  assert.equal(first.failed, 1);
  calls = [];
  await autoReassignOneDrive(new Date('2026-12-01T18:00:00Z'));
  assert.equal(calls.length, 0, 'no second try the same day');
  driveStatus = 200;
  const next = await autoReassignOneDrive(new Date('2026-12-02T15:00:00Z'));
  assert.equal(next.done, 1, 'retried the next day');
  const st = (db.prepare(`SELECT status FROM offboarding_items WHERE request_id = ? AND action_code = 'data_reassign'`).get(request.id) as any).status;
  assert.equal(st, 'done');
});
