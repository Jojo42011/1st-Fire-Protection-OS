import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `os-personal-tasks-test-${process.pid}.db`);
process.env.PERSONAL_TASK_USERS = 'me@1stfpservices.com';

import { getDb } from '../db/index';
import { initDb } from '../db/schema';
import { canUseTasks, addTask, listTasks, updateTask, deleteTask, buildDigest, signDone, taskForToken, centralNow } from './personalTasks';

initDb();
getDb().exec(`DELETE FROM personal_tasks`);
const ME = 'me@1stfpservices.com';
const now = new Date('2026-10-08T15:00:00Z'); // 10am Central
const today = centralNow(now).date;
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

test('only listed people can use My tasks', () => {
  assert.equal(canUseTasks(ME), true);
  assert.equal(canUseTasks('ME@1stFPservices.com'), true, 'case-insensitive');
  assert.equal(canUseTasks('someone@1stfpservices.com'), false);
  assert.equal(canUseTasks(null), false);
});

test('tasks belong to their owner and need a name', () => {
  assert.deepEqual(addTask(ME, { title: '   ' }), { error: 'Give the task a name.' });
  const t = addTask(ME, { title: 'Renew the domain', due_date: day(2), notes: 'GoDaddy' });
  assert.ok(!('error' in t));
  assert.equal(listTasks('other@x.com').length, 0, 'another person sees nothing');
  assert.equal(updateTask('other@x.com', (t as any).id, { done: true }), null, 'and cannot change it');
  assert.equal(deleteTask('other@x.com', (t as any).id), false);
});

test('the daily email groups overdue, today and upcoming, and skips done items', () => {
  getDb().exec(`DELETE FROM personal_tasks`);
  addTask(ME, { title: 'Late thing', due_date: day(-2) });
  addTask(ME, { title: 'Today thing', due_date: today });
  addTask(ME, { title: 'Soon thing', due_date: day(3) });
  addTask(ME, { title: 'Far thing', due_date: day(30) });
  addTask(ME, { title: 'Someday thing' });
  const done = addTask(ME, { title: 'Finished thing', due_date: day(-1) }) as any;
  updateTask(ME, done.id, { done: true });
  const d = buildDigest(ME, 'https://os.example', now)!;
  assert.equal(d.subject, 'Tasks: 1 due today, 1 overdue');
  assert.equal(d.count, 5);
  for (const label of ['Overdue (1)', 'Due today (1)', 'Next 7 days (1)', 'Later (1)', 'No due date (1)']) assert.match(d.html, new RegExp(label.replace(/[()]/g, '\\$&')));
  assert.match(d.html, /2 days late/);
  assert.doesNotMatch(d.html, /Finished thing/);
  assert.match(d.html, /https:\/\/os\.example\/tasks\/done\//);
});

test('no open tasks means no email', () => {
  getDb().exec(`DELETE FROM personal_tasks`);
  assert.equal(buildDigest(ME, 'https://os.example', now), null);
});

test('a signed Mark done link opens only its own task, and a tampered one does not', () => {
  const t = addTask(ME, { title: 'Signed link task' }) as any;
  const tok = signDone(t.id, ME);
  assert.equal(taskForToken(tok)!.task.id, t.id);
  assert.equal(taskForToken(tok.slice(0, -2) + 'xx'), null);
  assert.equal(taskForToken(signDone(t.id, ME, Date.now() - 50 * 86400000)), null, 'expired');
  assert.equal(taskForToken(signDone(t.id, 'someone@1stfpservices.com')), null, 'not a task user');
});
