import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-google-test-${process.pid}.db`);
process.env.OS_REQUIRE_IDENTITY = '0';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_BUSINESS_TOKEN;

import { initDb } from '../db/schema';
import {
  isPositive,
  replyFor,
  googleConfigured,
  googleConnected,
  connectionInfo,
  syncReviews,
  publishReply,
  accessToken,
} from './googleBusiness';

initDb();

test('isPositive splits at 4 stars (auto positive, hold negative)', () => {
  assert.equal(isPositive(5), true);
  assert.equal(isPositive(4), true);
  assert.equal(isPositive(3), false);
  assert.equal(isPositive(2), false);
  assert.equal(isPositive(1), false);
  assert.equal(isPositive(0), false);
});

test('replyFor: positive reply thanks by first name and includes the star count', () => {
  const r = replyFor(5, 'Maria Gonzalez', 'rev-abc');
  assert.match(r, /Maria/);
  assert.match(r, /5-star/);
  assert.doesNotMatch(r, /\{name\}|\{stars\}/); // all tokens filled
});

test('replyFor: held reply is an apology and never claims a star rating', () => {
  const r = replyFor(2, 'John Smith', 'rev-xyz');
  assert.match(r, /John/);
  assert.match(r, /sorry|make it right|reach out/i);
  assert.doesNotMatch(r, /\{name\}|\{stars\}/);
});

test('replyFor is deterministic for a given review id (re-runs match)', () => {
  const a = replyFor(5, 'Alex Doe', 'stable-id-1');
  const b = replyFor(5, 'Alex Doe', 'stable-id-1');
  assert.equal(a, b);
});

test('replyFor tolerates an empty reviewer name', () => {
  const r = replyFor(5, '', 'id');
  assert.match(r, /there/); // falls back to "there"
  assert.doesNotMatch(r, /\{name\}/);
});

test('keyless-safe: nothing is configured, so every entry point degrades gracefully', async () => {
  assert.equal(googleConfigured(), false);
  assert.equal(googleConnected(), false);
  const info = connectionInfo();
  assert.equal(info.configured, false);
  assert.equal(info.connected, false);

  // accessToken returns null (not a throw) when nothing is connected.
  assert.equal(await accessToken(), null);

  // syncReviews returns a shaped result with ok:false, never throws.
  const sync = await syncReviews();
  assert.equal(sync.ok, false);
  assert.equal(sync.pulled, 0);
  assert.equal(sync.autoReplied, 0);

  // publishReply on a non-existent row is a graceful failure, not a crash.
  const pub = await publishReply(999999, 'hello');
  assert.equal(pub.ok, false);
});
