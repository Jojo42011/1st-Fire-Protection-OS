import express, { Router } from 'express';
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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,-apple-system,"Segoe UI",sans-serif;background:#f5f5f7;color:#1d1d1f}
main{width:min(460px,calc(100% - 32px));margin:24px auto;padding:28px;background:#fff;border-radius:22px;box-shadow:0 0 0 1px rgba(0,0,0,.06),0 30px 60px -30px rgba(29,29,31,.3)}
h1{font-size:21px;margin:0 0 6px;letter-spacing:-.02em}.sub{color:#6e6e73;margin:0 0 18px;line-height:1.5}
.box{background:#f5f5f7;border-radius:12px;padding:12px 14px;margin:0 0 18px;font-size:14px;line-height:1.5;white-space:pre-wrap}.box b{display:block;font-size:15px;white-space:normal}
button,a.btn{display:block;width:100%;box-sizing:border-box;text-align:center;min-height:46px;line-height:46px;border-radius:980px;font:inherit;font-size:15px;font-weight:700;cursor:pointer;border:0;background:#d62d2a;color:#fff;text-decoration:none}
a.btn{background:#fff;color:#1d1d1f;box-shadow:inset 0 0 0 1px #d2d2d7;margin-top:10px}.ok{color:#12805c;font-weight:700}
</style></head><body><main>${body}</main></body></html>`;
}
const invalid = () => page('Link not valid', `<h1>This link does not work anymore</h1><p class="sub">It may have expired or the task was deleted. Open My tasks in the OS instead.</p>`);
const box = (t: { title: string; notes: string | null }) => `<div class="box"><b>${esc(t.title)}</b>${t.notes ? esc(t.notes) : ''}</div>`;

router.get('/tasks/done/:token', (req, res) => {
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
  const x = taskForToken(req.params.token);
  if (!x) return res.status(404).type('html').send(invalid());
  if (x.task.status === 'done') return res.type('html').send(page('Already done', `<h1 class="ok">Already done</h1>${box(x.task)}<a class="btn" href="/?tab=myTasks">Open My tasks</a>`));
  res.type('html').send(page('Mark task done', `<h1>Mark this done?</h1>${box(x.task)}<form method="post"><button>Mark done</button></form><a class="btn" href="/?tab=myTasks">Open My tasks</a>`));
});
router.post('/tasks/done/:token', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const x = taskForToken(req.params.token);
  if (!x) return res.status(404).type('html').send(invalid());
  updateTask(x.email, x.task.id, { done: true });
  res.type('html').send(page('Done', `<h1 class="ok">Done</h1>${box(x.task)}<p class="sub">It is off your list and out of tomorrow's email.</p><a class="btn" href="/?tab=myTasks">Open My tasks</a>`));
});

export default router;
