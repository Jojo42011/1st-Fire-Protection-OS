import express from 'express';
import { currentUser, AppUser } from './authz';

/**
 * Who may tick off, approve or reject an onboarding/offboarding item. Approvals are the human gate,
 * so the decision is recorded against a real signed-in person (never a name the browser sends), and
 * only someone who can see that item's lane may decide it.
 */
export type DeciderResult = { ok: true; user: AppUser; actor: string } | { ok: false; status: number; error: string };

export function decider(req: express.Request, canSeeLane: (user: AppUser) => boolean): DeciderResult {
  const user = currentUser(req);
  if (!user) return { ok: false, status: 401, error: 'Sign in with Microsoft to approve or complete items, so the decision is recorded under your name.' };
  if (!user.roles.length) return { ok: false, status: 403, error: 'Your account has no role in Access & roles yet. Ask a People admin to add one.' };
  if (!canSeeLane(user)) return { ok: false, status: 403, error: "This item belongs to another team's lane." };
  return { ok: true, user, actor: user.email };
}

export function sendDenied(res: express.Response, d: Extract<DeciderResult, { ok: false }>): void {
  res.status(d.status).json({ ok: false, error: d.error });
}
