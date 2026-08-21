/**
 * Google Business Profile: read reviews across every location the connected Google account owns, and
 * post replies. Uses a delegated OAuth connection (the owner signs in once, we keep a refresh token),
 * the Account Management + Business Information APIs to enumerate locations, and the legacy v4 API for
 * reviews and replies.
 *
 * Two real external gates, both outside our code: (1) a Google Cloud OAuth client
 * (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), and (2) Google must approve the project for the Business
 * Profile APIs before reviews return. Keyless/permissionless-safe: every export returns a shaped
 * result instead of throwing, so a missing grant or pending approval never crashes a sweep.
 *
 * Reply policy (chosen by the user): auto-reply to 4-5 star reviews from a template and publish
 * immediately; draft a reply for 3-and-under and HOLD it for a human to approve.
 */
import { getDb } from '../db/index';

const OAUTH = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/business.manage openid email';

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
function conn(): { refresh_token: string | null; email: string | null; account_name: string | null; connected_at: string | null } | null {
  try { return (getDb().prepare(`SELECT refresh_token, email, account_name, connected_at FROM google_connection WHERE id = 1`).get() as any) || null; }
  catch { return null; }
}
export function googleConnected(): boolean {
  const c = conn();
  return !!(c && c.refresh_token);
}
export function connectionInfo(): { configured: boolean; connected: boolean; email: string | null; account: string | null; connected_at: string | null } {
  const c = conn();
  return { configured: googleConfigured(), connected: !!(c && c.refresh_token), email: c ? c.email : null, account: c ? c.account_name : null, connected_at: c ? c.connected_at : null };
}

/** The consent URL the owner visits to grant access. redirectUri must be registered on the OAuth client. */
export function authUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID as string,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token every time
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Exchange the authorization code for tokens, capture the owner's email + first account, and store. */
export async function exchangeCode(code: string, redirectUri: string, connectedBy: string): Promise<{ ok: boolean; error?: string; email?: string }> {
  if (!googleConfigured()) return { ok: false, error: 'Google is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' };
  try {
    const res = await fetch(OAUTH, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID as string, client_secret: process.env.GOOGLE_CLIENT_SECRET as string, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(),
    });
    const j = (await res.json()) as any;
    if (!res.ok || !j.refresh_token) return { ok: false, error: j.error_description || j.error || 'no refresh token returned (was consent granted with offline access?)' };
    const access = j.access_token as string;
    let email: string | null = null;
    try { const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${access}` } }); if (u.ok) email = ((await u.json()) as any).email || null; } catch { /* non-fatal */ }
    let account: string | null = null;
    try { const accts = await listAccounts(access); account = accts.ok && accts.accounts[0] ? accts.accounts[0].name : null; } catch { /* non-fatal, pending approval */ }
    getDb().prepare(
      `INSERT INTO google_connection (id, refresh_token, email, scope, account_name, connected_by, connected_at)
       VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET refresh_token=excluded.refresh_token, email=excluded.email, scope=excluded.scope, account_name=COALESCE(excluded.account_name, google_connection.account_name), connected_by=excluded.connected_by, connected_at=datetime('now')`
    ).run(j.refresh_token, email, SCOPES, account, connectedBy);
    return { ok: true, email: email || undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function disconnect(): void {
  try { getDb().prepare(`DELETE FROM google_connection WHERE id = 1`).run(); } catch { /* ignore */ }
}

/** A fresh access token from the stored refresh token. Null when not connected or on failure. */
export async function accessToken(): Promise<string | null> {
  const c = conn();
  if (!c || !c.refresh_token || !googleConfigured()) return null;
  try {
    const res = await fetch(OAUTH, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID as string, client_secret: process.env.GOOGLE_CLIENT_SECRET as string, refresh_token: c.refresh_token, grant_type: 'refresh_token' }).toString(),
    });
    if (!res.ok) return null;
    return ((await res.json()) as any).access_token || null;
  } catch { return null; }
}

export async function listAccounts(token: string): Promise<{ ok: boolean; error?: string; accounts: { name: string; accountName?: string }[] }> {
  try {
    const res = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, error: `accounts ${res.status}: ${(await res.text()).slice(0, 200)}`, accounts: [] };
    const j = (await res.json()) as any;
    return { ok: true, accounts: (j.accounts || []).map((a: any) => ({ name: a.name, accountName: a.accountName })) };
  } catch (err) { return { ok: false, error: (err as Error).message, accounts: [] }; }
}

export async function listLocations(token: string, accountName: string): Promise<{ ok: boolean; error?: string; locations: { name: string; title: string }[] }> {
  try {
    const out: { name: string; title: string }[] = [];
    let pageToken = '';
    let guard = 0;
    do {
      const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return { ok: false, error: `locations ${res.status}: ${(await res.text()).slice(0, 200)}`, locations: [] };
      const j = (await res.json()) as any;
      for (const l of j.locations || []) out.push({ name: l.name, title: l.title || l.name });
      pageToken = j.nextPageToken || '';
    } while (pageToken && ++guard < 20);
    return { ok: true, locations: out };
  } catch (err) { return { ok: false, error: (err as Error).message, locations: [] }; }
}

const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
export interface GReview { reviewId: string; reviewer: string; stars: number; comment: string; createTime: string; hasReply: boolean }

export async function listReviews(token: string, accountId: string, locationId: string): Promise<{ ok: boolean; error?: string; reviews: GReview[] }> {
  try {
    const out: GReview[] = [];
    let pageToken = '';
    let guard = 0;
    do {
      const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews?pageSize=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return { ok: false, error: `reviews ${res.status}: ${(await res.text()).slice(0, 200)}`, reviews: [] };
      const j = (await res.json()) as any;
      for (const r of j.reviews || []) {
        out.push({ reviewId: r.reviewId, reviewer: (r.reviewer && r.reviewer.displayName) || 'A customer', stars: STAR[r.starRating] || 0, comment: r.comment || '', createTime: r.createTime || '', hasReply: !!r.reviewReply });
      }
      pageToken = j.nextPageToken || '';
    } while (pageToken && ++guard < 20);
    return { ok: true, reviews: out };
  } catch (err) { return { ok: false, error: (err as Error).message, reviews: [] }; }
}

export async function replyToReview(token: string, accountId: string, locationId: string, reviewId: string, comment: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ comment }),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `reply ${res.status}: ${(await res.text()).slice(0, 200)}` };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
}

/* ─────────────────────────── reply policy (pure, unit-tested) ─────────────────────────── */

const POSITIVE_TEMPLATES = [
  'Thank you so much for the kind words and the {stars}-star review, {name}! We really appreciate you trusting 1st Fire Protection, and we look forward to serving you again.',
  'We appreciate you, {name}! Thank you for the {stars}-star review. It means a lot to our team at 1st Fire Protection, and we are glad we could help.',
  'Thanks for the great review, {name}! Reviews like yours keep our team motivated. We are always here if you need anything from 1st Fire Protection.',
];
const HELD_TEMPLATE = 'Thank you for the feedback, {name}. We are sorry your experience was not what you expected, and we would like to make it right. Please reach out to us directly so we can look into this.';

/** Is this rating one we auto-reply to (4-5), or hold for a human (1-3)? */
export function isPositive(stars: number): boolean { return stars >= 4; }

/** A reply for a review. Positive -> a rotating thank-you (deterministic by review id so re-runs match);
 *  held -> a careful acknowledgement the human can edit before approving. */
export function replyFor(stars: number, reviewerName: string, reviewId: string): string {
  const name = (reviewerName || '').split(' ')[0] || 'there';
  if (isPositive(stars)) {
    const idx = Math.abs(hashCode(reviewId)) % POSITIVE_TEMPLATES.length;
    return POSITIVE_TEMPLATES[idx].replace('{stars}', String(stars)).replace('{name}', name);
  }
  return HELD_TEMPLATE.replace('{name}', name);
}
function hashCode(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

/* ─────────────────────────── the sync: pull, store, auto-reply ─────────────────────────── */

const idFromPath = (path: string) => (path || '').split('/').pop() || '';

export async function syncReviews(): Promise<{ ok: boolean; error?: string; locations: number; pulled: number; autoReplied: number; held: number }> {
  if (!googleConfigured()) return { ok: false, error: 'Google is not configured', locations: 0, pulled: 0, autoReplied: 0, held: 0 };
  if (!googleConnected()) return { ok: false, error: 'Google Business Profile is not connected', locations: 0, pulled: 0, autoReplied: 0, held: 0 };
  const token = await accessToken();
  if (!token) return { ok: false, error: 'could not refresh the Google access token', locations: 0, pulled: 0, autoReplied: 0, held: 0 };
  const accts = await listAccounts(token);
  if (!accts.ok) return { ok: false, error: accts.error, locations: 0, pulled: 0, autoReplied: 0, held: 0 };
  const db = getDb();
  const findExisting = db.prepare(`SELECT id, reply_status FROM reviews WHERE ext_id = ?`);
  const insert = db.prepare(`INSERT INTO reviews (source, author, stars, text, received_at, reply_draft, reply_status, ext_id, location, auto_replied, reply_published_at) VALUES ('google', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let locations = 0, pulled = 0, autoReplied = 0, held = 0;

  for (const acct of accts.accounts) {
    const accountId = idFromPath(acct.name);
    const locs = await listLocations(token, acct.name);
    if (!locs.ok) continue;
    for (const loc of locs.locations) {
      locations++;
      const locationId = idFromPath(loc.name);
      const revs = await listReviews(token, accountId, locationId);
      if (!revs.ok) continue;
      for (const r of revs.reviews) {
        if (findExisting.get(r.reviewId)) continue; // already have it
        pulled++;
        const draft = replyFor(r.stars, r.reviewer, r.reviewId);
        if (r.hasReply) {
          // Already answered on Google (by us or before): record as published, no action.
          insert.run(r.reviewer, r.stars, r.comment, r.createTime || null, null, 'published', r.reviewId, loc.title, 0, r.createTime || null);
        } else if (isPositive(r.stars)) {
          const out = await replyToReview(token, accountId, locationId, r.reviewId, draft);
          if (out.ok) { insert.run(r.reviewer, r.stars, r.comment, r.createTime || null, draft, 'published', r.reviewId, loc.title, 1, new Date().toISOString()); autoReplied++; }
          else { insert.run(r.reviewer, r.stars, r.comment, r.createTime || null, draft, 'draft', r.reviewId, loc.title, 0, null); held++; }
        } else {
          insert.run(r.reviewer, r.stars, r.comment, r.createTime || null, draft, 'draft', r.reviewId, loc.title, 0, null); held++;
        }
      }
    }
  }
  return { ok: true, locations, pulled, autoReplied, held };
}

/** Post a specific stored review's reply to Google (used when a human approves a held reply). */
export async function publishReply(reviewRowId: number, comment: string): Promise<{ ok: boolean; error?: string }> {
  if (!googleConnected()) return { ok: false, error: 'Google Business Profile is not connected' };
  const db = getDb();
  const row = db.prepare(`SELECT ext_id, location FROM reviews WHERE id = ?`).get(reviewRowId) as any;
  if (!row || !row.ext_id) return { ok: false, error: 'not a Google review (no review id to post to)' };
  const token = await accessToken();
  if (!token) return { ok: false, error: 'could not refresh the Google access token' };
  const accts = await listAccounts(token);
  // Find the account/location that owns this review by re-resolving; the review id is unique per location.
  for (const acct of accts.accounts) {
    const accountId = idFromPath(acct.name);
    const locs = await listLocations(token, acct.name);
    for (const loc of locs.locations) {
      if (loc.title !== row.location) continue;
      const out = await replyToReview(token, accountId, idFromPath(loc.name), row.ext_id, comment);
      if (out.ok) { db.prepare(`UPDATE reviews SET reply_status='published', reply_published_at=? WHERE id=?`).run(new Date().toISOString(), reviewRowId); return { ok: true }; }
      return out;
    }
  }
  return { ok: false, error: 'could not find the location for this review' };
}
