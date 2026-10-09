import express, { Router } from 'express';
import { brandPage } from '../services/brandPage';
import { currentContext } from '../os/scope';
import { canUseTasks, listTasks, addTask, updateTask, deleteTask, sendDigestNow, taskForToken, centralNow } from '../services/personalTasks';

/**
 * My tasks: a personal to-do list. Every API call is scoped to the signed-in person and refused for
 * anyone not on the PERSONAL_TASK_USERS list. /tasks/done/<token> is the signed "Mark done" link from
 * the daily email; it works without a session (the token is the credential) and only a POST changes
 * anything, because mail scanners open links.
 */
const router = Router();

function owner(req: express.Request, res: express.Response): string | null {
  const email = currentContext(req).email;
  if (!canUseTasks(email)) { res.status(403).json({ ok: false, error: 'My tasks is not turned on for your account.' }); return null; }
  return String(email).toLowerCase();
}

router.get('/api/my-tasks', (req, res) => {
  const me = owner(req, res); if (!me) return;
  res.json({ ok: true, email: me, today: centralNow().date, tasks: listTasks(me) });
});
router.post('/api/my-tasks', (req, res) => {
  const me = owner(req, res); if (!me) return;
  const t = addTask(me, req.body || {});
  if ('error' in t) return res.status(400).json({ ok: false, error: t.error });
  res.json({ ok: true, task: t });
});
router.patch('/api/my-tasks/:id(\\d+)', (req, res) => {
  const me = owner(req, res); if (!me) return;
  const t = updateTask(me, Number(req.params.id), req.body || {});
  if (!t) return res.status(404).json({ ok: false, error: 'Task not found.' });
  if ('error' in t) return res.status(400).json({ ok: false, error: t.error });
  res.json({ ok: true, task: t });
});
router.delete('/api/my-tasks/:id(\\d+)', (req, res) => {
  const me = owner(req, res); if (!me) return;
  if (!deleteTask(me, Number(req.params.id))) return res.status(404).json({ ok: false, error: 'Task not found.' });
  res.json({ ok: true });
});
router.post('/api/my-tasks/send-now', async (req, res) => {
  const me = owner(req, res); if (!me) return;
  const base = `${req.protocol}://${req.get('host')}`;
  const out = await sendDigestNow(me, base);
  res.status(out.ok ? 200 : 400).json(out);
});

/* ─────────── signed "Mark done" link from the email ─────────── */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
function page(title: string, body: string): string {
  return brandPage(title, body);
}
const invalid = () => page('Link not valid', `<h1>This link does not work anymore</h1><p class="sub">It may have expired or the task was deleted. Open My tasks in the OS instead.</p>`);
const box = (t: { title: string; notes: string | null }) => `<div class="box"><b>${esc(t.title)}</b>${t.notes ? `<span class="pre">${esc(t.notes)}</span>` : ''}</div>`;

router.get('/tasks/done/:token', (req, res) => {
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
  const x = taskForToken(req.params.token);
  if (!x) return res.status(404).type('html').send(invalid());
  if (x.test) return res.type('html').send(page('Mark task done', `<h1>Mark this done?</h1><p class="sub">Test email: this is a sample task, so nothing on your list changes.</p>${box(x.task)}<form method="post"><button class="go">Mark done</button></form><a class="btn" href="/?tab=myTasks">Open My tasks</a>`));
  if (x.task.status === 'done') return res.type('html').send(page('Already done', `<h1 class="ok">Already done</h1>${box(x.task)}<a class="btn" href="/?tab=myTasks">Open My tasks</a>`));
  res.type('html').send(page('Mark task done', `<h1>Mark this done?</h1>${box(x.task)}<form method="post"><button class="go">Mark done</button></form><a class="btn" href="/?tab=myTasks">Open My tasks</a>`));
});
router.post('/tasks/done/:token', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const x = taskForToken(req.params.token);
  if (!x) return res.status(404).type('html').send(invalid());
  if (x.test) return res.type('html').send(page('Done', `<h1 class="ok">The button works</h1>${box(x.task)}<p class="sub">This was a sample task from the test email, so nothing changed. Real tasks come off your list and out of the next email.</p><a class="btn" href="/?tab=myTasks">Open My tasks</a>`));
  updateTask(x.email, x.task.id, { done: true });
  res.type('html').send(page('Done', `<h1 class="ok">Done</h1>${box(x.task)}<p class="sub">It is off your list and out of tomorrow's email.</p><a class="btn" href="/?tab=myTasks">Open My tasks</a>`));
});

export default router;
