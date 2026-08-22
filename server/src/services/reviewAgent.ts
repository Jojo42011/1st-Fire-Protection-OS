import { getDb } from '../db/index';
import { chat } from './llm';
import { COMPANY } from '../config/constants';

/**
 * Review Collector engine — drafts warm review requests per completed job and professional
 * replies per incoming review. ALL gated (draft only; a human approves before it publishes/sends).
 */

interface Job {
  id: number;
  customer: string;
  job_desc: string | null;
  completed_at: string | null;
  requested: number;
}

interface Review {
  id: number;
  source: string | null;
  author: string | null;
  stars: number | null;
  text: string | null;
  received_at: string | null;
  reply_draft: string | null;
  reply_status: string;
}

function templateRequest(job: Job): string {
  return [
    `Hi ${job.customer},`,
    '',
    `Thanks again for letting ${COMPANY.name} handle your ${job.job_desc || 'fire protection work'}. Keeping people and property safe is what we do, and we'd be grateful if you'd share a quick review of how it went.`,
    '',
    `It takes about a minute and helps other Texas businesses find a licensed & insured team they can trust.`,
    '',
    `${COMPANY.name} · ${COMPANY.phone}`,
  ].join('\n');
}

export async function draftReviewRequest(jobId: number): Promise<{ id: number; body: string }> {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job | undefined;
  if (!job) throw new Error(`job ${jobId} not found`);

  let body = templateRequest(job);
  const result = await chat(
    [
      {
        role: 'system',
        content: `You draft short, warm review-request messages for ${COMPANY.name} (fire protection & life safety, Texas). Brand voice: ${COMPANY.brandVoice}. Reference the specific job. Under 90 words. Output ONLY the message.`,
      },
      { role: 'user', content: `Customer: ${job.customer}\nJob: ${job.job_desc}` },
    ],
    { fast: true, maxTokens: 300 }
  );
  if (result && result.text) body = result.text;

  const info = db
    .prepare(
      `INSERT INTO review_requests (job_id, customer, job_desc, channel, body, status) VALUES (?, ?, ?, 'email', ?, 'draft')`
    )
    .run(jobId, job.customer, job.job_desc, body);
  db.prepare('UPDATE jobs SET requested = 1 WHERE id = ?').run(jobId);
  return { id: Number(info.lastInsertRowid), body };
}

function templateReply(r: Review): string {
  const stars = r.stars || 0;
  if (stars >= 4) {
    return `Thank you so much, ${r.author || 'and'}, it means a lot to the whole ${COMPANY.name} crew. Keeping your people and property safe is exactly why we do this. We're here anytime you need us.`;
  }
  if (stars === 3) {
    return `Thanks for the honest feedback, ${r.author || ''}. We want every visit to be a five-star one. Please reach out to us directly at ${COMPANY.phone} so we can make it right.`;
  }
  return `We're sorry your experience fell short, ${r.author || ''}. That's not the standard we hold ourselves to. Please contact us directly at ${COMPANY.phone}. We'd like to understand what happened and make it right.`;
}

export async function draftReviewReply(reviewId: number): Promise<{ id: number; body: string }> {
  const db = getDb();
  const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId) as Review | undefined;
  if (!r) throw new Error(`review ${reviewId} not found`);

  let body = templateReply(r);
  const result = await chat(
    [
      {
        role: 'system',
        content: `You draft public replies to customer reviews for ${COMPANY.name} (fire protection & life safety, Texas). Thank 5-stars warmly; de-escalate low stars and invite them to contact ${COMPANY.phone}. Never defensive. Under 70 words. Output ONLY the reply.`,
      },
      { role: 'user', content: `${r.stars}★ from ${r.author} on ${r.source}: "${r.text}"` },
    ],
    { fast: true, maxTokens: 250 }
  );
  if (result && result.text) body = result.text;

  db.prepare(`UPDATE reviews SET reply_draft = ?, reply_status = 'draft' WHERE id = ?`).run(body, reviewId);
  return { id: reviewId, body };
}

export interface ReputationSummary {
  avgRating: number;
  totalReviews: number;
  thisMonthDelta: number;
  distribution: { [k: number]: number };
}

export function getReputationSummary(): ReputationSummary {
  const db = getDb();
  const reviews = db.prepare('SELECT stars, received_at FROM reviews WHERE stars IS NOT NULL').all() as {
    stars: number;
    received_at: string | null;
  }[];
  const distribution: { [k: number]: number } = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  let monthCount = 0;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  for (const r of reviews) {
    distribution[r.stars] = (distribution[r.stars] || 0) + 1;
    sum += r.stars;
    if (r.received_at && new Date(r.received_at) >= monthStart) monthCount++;
  }
  return {
    avgRating: reviews.length ? sum / reviews.length : 0,
    totalReviews: reviews.length,
    thisMonthDelta: monthCount,
    distribution,
  };
}
