import { getDb } from '../db/index';
import { getState, setState } from '../db/schema';
import { graphOffboardConfigured, runCloudAction } from './msGraphOffboard';
import { completeItemByScript, offboardingFrom } from './offboardingAgent';
import { sendMail, mailCredsPresent } from './msGraphMail';
import { osAudit } from '../os/audit';

/**
 * Offboarding steps the OS now does by itself instead of handing them to a person.
 *
 * "Reassign OneDrive and shared files" (the manager's step): once the person's last day arrives, the
 * OS grants their manager write access to the departing person's whole OneDrive through Microsoft
 * Graph, emails the manager the link with what to do, and marks the step done. Files they shared from
 * OneDrive keep working for everyone until the account is retired; anything the team needs long term
 * should be moved into SharePoint before then. Runs hourly from the scheduler; a failure (no OneDrive,
 * missing Graph permission) is retried at most once a day and the step stays on the board meanwhile.
 */

const TZ = 'America/Chicago';
const todayCT = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const niceDate = (d: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : null;
};

export function managerHandoverHtml(r: { name: string; retain_until?: string | null }, url: string | null): string {
  const until = niceDate(r.retain_until);
  return `<div style="font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;color:#1d1d1f;max-width:560px;font-size:14px;line-height:1.55">
  <p style="font-size:18px;font-weight:800;margin:0 0 8px">You have access to ${esc(r.name)}'s OneDrive</p>
  <p style="margin:0 0 12px">As part of ${esc(r.name)}'s offboarding, you can now open and edit everything in their OneDrive.</p>
  ${url ? `<p style="margin:0 0 16px"><a href="${esc(url)}" style="background:#d62d2a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:980px;display:inline-block;font-weight:700">Open their OneDrive</a></p>` : ''}
  <p style="margin:0 0 6px"><b>What to do</b></p>
  <ul style="margin:0 0 12px;padding-left:20px">
    <li>Move anything the team still needs into the right SharePoint folder or Team.</li>
    <li>Files they shared with others keep working until the account is retired${until ? ` on <b>${esc(until)}</b>` : ''}. After that, their OneDrive and its share links are deleted.</li>
    <li>Nothing else is needed from you for this step: it is already marked done.</li>
  </ul>
  <p style="font-size:12px;color:#86868b;margin-top:16px">Sent by the 1st FP OS offboarding checklist.</p>
</div>`;
}

export async function autoReassignOneDrive(now = new Date()): Promise<{ done: number; failed: number; skipped?: string }> {
  if (!graphOffboardConfigured()) return { done: 0, failed: 0, skipped: 'Microsoft Graph is not connected' };
  const today = todayCT(now);
  const rows = getDb().prepare(
    `SELECT i.id, i.request_id, i.due_at, r.name, r.upn, r.forward_to, r.manager_email, r.retain_until, r.office
       FROM offboarding_items i JOIN offboarding_requests r ON r.id = i.request_id
      WHERE i.action_code = 'data_reassign' AND i.status = 'pending'
        AND (r.status IS NULL OR r.status = 'open')
        AND (i.due_at IS NULL OR substr(i.due_at, 1, 10) <= ?)`
  ).all(today) as any[];
  let done = 0, failed = 0;
  for (const r of rows) {
    const tried = `offb_auto_onedrive:${r.id}`;
    if (getState(tried) === today) continue; // one attempt a day after a failure
    const to = String(r.forward_to || r.manager_email || '').trim();
    const out = await runCloudAction('data_reassign', r);
    osAudit({
      actor: 'automation', actor_email: null, office: r.office ?? null, module: 'offboarding',
      action: out.ok ? 'offboarding.auto_onedrive' : 'offboarding.auto_onedrive_failed',
      subject_type: 'offboarding_item', subject_id: r.id,
      detail: `${r.name}: ${out.ok ? out.detail || 'OneDrive access granted' : out.error || 'failed'}`,
    });
    if (!out.ok) { setState(tried, today); failed++; continue; }
    completeItemByScript(r.id);
    getDb().prepare(`UPDATE offboarding_items SET decided_by = 'automation' WHERE id = ?`).run(r.id);
    done++;
    if (to && mailCredsPresent()) {
      await sendMail(to, `You have access to ${r.name}'s OneDrive`, managerHandoverHtml(r, out.url || null), { from: offboardingFrom(), fromName: '1st FP Offboarding' }).catch(() => undefined);
    }
  }
  return { done, failed };
}
