import crypto from 'crypto';

/**
 * One-click approval links for onboarding approvals emailed to people who may not sign in to the OS
 * (a hire's manager). A link is signed for ONE item and ONE recipient and expires; opening it shows a
 * page with Approve / Reject buttons (a plain GET never decides, because mail scanners open links).
 * The decision is recorded under the recipient's email.
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string {
  return crypto.createHash('sha256').update('fpos-approval|' + (process.env.PEOPLE_SESSION_SECRET || process.env.APP_PASSWORD || 'dev-approval-secret')).digest('hex');
}

export function signApproval(itemId: number, email: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ i: itemId, e: String(email).toLowerCase(), x: now + TTL_MS })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

export function verifyApproval(token: string, now = Date.now()): { itemId: number; email: string } | null {
  const t = String(token || '');
  const dot = t.indexOf('.');
  if (dot < 1) return null;
  const body = t.slice(0, dot), sig = t.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof d.i !== 'number' || typeof d.e !== 'string' || typeof d.x !== 'number' || d.x < now) return null;
    return { itemId: d.i, email: d.e };
  } catch { return null; }
}

export function approvalUrl(base: string, itemId: number, email: string): string {
  return `${base.replace(/\/$/, '')}/approve/${signApproval(itemId, email)}`;
}
