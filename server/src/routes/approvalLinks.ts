import express, { Router } from 'express';
import { getDb } from '../db/index';
import { verifyApproval } from '../services/approvalLinks';
import { approveItem, rejectItem, OnboardingItem } from '../services/onboardingAgent';
import { notifyFollowUp, notifyRejection, startDateInfo } from '../services/onboardingOwners';

/**
 * Public: the page behind a "Review and approve" email button. The signed link names one item and the
 * person it was sent to; opening it only shows the decision, and the Approve / Reject buttons POST.
 */
const router = Router();
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const baseUrl = (req: express.Request) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7f9;color:#14213a}
main{width:min(480px,calc(100% - 32px));margin:24px auto;padding:28px;background:#fff;border:1px solid #e5e8ed;border-radius:16px;box-shadow:0 8px 24px rgba(20,33,58,.06)}
h1{font-size:21px;margin:0 0 6px;letter-spacing:-.02em}.sub{color:#5a6577;margin:0 0 18px;line-height:1.5}.box{background:#f2f5f9;border-radius:10px;padding:12px 14px;margin:0 0 18px;font-size:14px;line-height:1.5}
.box b{display:block;font-size:15px}textarea{width:100%;box-sizing:border-box;min-height:74px;border:1px solid #d0d5dd;border-radius:10px;padding:10px;font:inherit;font-size:15px;margin:6px 0 12px}
.row{display:flex;gap:10px;flex-wrap:wrap}button{flex:1;min-height:46px;border-radius:10px;font:inherit;font-size:15px;font-weight:600;cursor:pointer;border:1px solid #d0d5dd;background:#fff;color:#14213a}
button.go{background:#14213a;border-color:#14213a;color:#fff}label{font-size:13px;color:#5a6577}.done{color:#12805c;font-weight:600}.no{color:#b42318;font-weight:600}
</style></head><body><main>${body}</main></body></html>`;
}

function load(token: string): { item: OnboardingItem; email: string; req: any } | null {
  const v = verifyApproval(token);
  if (!v) return null;
  const item = getDb().prepare(`SELECT * FROM onboarding_items WHERE id = ?`).get(v.itemId) as OnboardingItem | undefined;
  if (!item || item.kind !== 'approval') return null;
  const req = getDb().prepare(`SELECT name, start_date, job_position, status FROM onboarding_requests WHERE id = ?`).get(item.request_id) as any;
  if (!req || req.status === 'discarded') return null;
  return { item, email: v.email, req };
}

const invalid = () => page('Link not valid', `<h1>This link is not valid anymore</h1><p class="sub">It may have expired or the onboarding was withdrawn. Open the onboarding board in the 1st FP OS, or ask IT to resend it.</p>`);

function summary(item: OnboardingItem, req: any): string {
  const st = startDateInfo(req.start_date);
  return `<div class="box"><b>${esc(item.label.replace(/^Approve (\w)/, (_m: string, c: string) => c.toUpperCase()))}</b>${item.detail ? esc(item.detail) : ''}</div>
    <p class="sub">For <b>${esc(req.name)}</b>${req.job_position ? `, ${esc(req.job_position)}` : ''}${st ? `, starting ${esc(st.long)}${st.relative ? ` (${esc(st.relative)})` : ''}` : ''}.</p>`;
}

router.get('/approve/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  const x = load(req.params.token);
  if (!x) return res.status(404).type('html').send(invalid());
  const { item, req: r } = x;
  if (item.status !== 'pending') {
    return res.type('html').send(page('Already decided', `<h1>Already ${esc(item.status)}</h1>${summary(item, r)}<p class="sub">Decided by ${esc(item.decided_by || 'someone')}${item.decided_at ? ` on ${esc(String(item.decided_at).slice(0, 10))}` : ''}. Nothing else to do.</p>`));
  }
  res.type('html').send(page('Approve new hire request', `<h1>Approval needed</h1>${summary(item, r)}
    <form method="post"><div class="row"><button class="go" name="action" value="approve">Approve</button></div>
      <p style="margin:18px 0 0"><label for="reason">Not approving? Say why (sent along with the decision).</label></p>
      <textarea id="reason" name="reason" placeholder="For example: reuse the spare laptop in Waco"></textarea>
      <div class="row"><button name="action" value="reject">Don't approve</button></div></form>`));
});

router.post('/approve/:token', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const x = load(req.params.token);
  if (!x) return res.status(404).type('html').send(invalid());
  const { item, email, req: r } = x;
  const action = String(req.body?.action || '');
  if (item.status !== 'pending') return res.redirect(303, req.originalUrl);
  const base = baseUrl(req);
  if (action === 'approve') {
    const out = approveItem(item.id, email);
    if (out.followUp) await notifyFollowUp(out, out.followUp, email, base).catch(() => ({ sent: 0 }));
    return res.type('html').send(page('Approved', `<h1 class="done">Approved</h1>${summary(item, r)}<p class="sub">${out.followUp ? `IT has been asked to ${esc(out.followUp.label.charAt(0).toLowerCase() + out.followUp.label.slice(1))}.` : 'Thanks, that is recorded.'}</p>`));
  }
  if (action === 'reject') {
    const out = rejectItem(item.id, email, req.body?.reason);
    await notifyRejection(out, email, base).catch(() => ({ ok: false }));
    return res.type('html').send(page('Not approved', `<h1 class="no">Not approved</h1>${summary(item, r)}<p class="sub">Recorded${out.note ? `, with your reason` : ''}. IT has been told.</p>`));
  }
  res.status(400).type('html').send(invalid());
});

export default router;
