import { getDb } from '../db/index';
import { chat } from './llm';
import { COMPANY } from '../config/constants';
import { integrationConnected } from '../config/integrations';

/**
 * Review Campaign — the staged review-request engine for the Review Collector.
 *
 * A completed unit of work from ServiceTrade — a job, an inspection, or a service call —
 * becomes a candidate the moment it's marked complete. Enrolling that job is the human gate
 * (a person decides to start asking). Once enrolled, the campaign walks an ordered sequence
 * of STAGES, each a timed, on-brand touch that drafts + sends a Google review request:
 *
 *   Stage 1 · Initial Ask     — right after completion, warm + specific to the work done
 *   Stage 2 · Gentle Reminder — a few days later, light and no-pressure
 *   Stage 3 · Last Call       — a final effortless nudge, then the campaign completes
 *
 * It stops early the instant the customer leaves a review (mark-reviewed → auto-complete),
 * so we never pester someone who already came through.
 *
 * Graceful degradation (standalone-until-connected): when the Email (Gmail/M365) or SMS
 * (Twilio) integration isn't present, that channel is SIMULATED — the request is drafted
 * and logged, nothing leaves the building. Add the key and the same stages send for real.
 * ServiceTrade fields (job_type, technician, location, contact) are pulled straight from the job.
 */

const CHANNELS = ['email', 'sms'] as const;
export type Channel = (typeof CHANNELS)[number];

/** A single review-campaign stage. offsetDays is the gap AFTER the previous stage. */
export interface Stage {
  key: 'ask' | 'reminder' | 'final';
  name: string;
  offsetDays: number;
  tone: string;
}

/** The ordered stage sequence. Stage 1 fires on enroll (offset 0); the rest are timed. */
export const STAGES: Stage[] = [
  {
    key: 'ask',
    name: 'Initial Ask',
    offsetDays: 0,
    tone: 'warm and appreciative — thank them for their trust and ask for a quick Google review',
  },
  {
    key: 'reminder',
    name: 'Gentle Reminder',
    offsetDays: 3,
    tone: 'a light, no-pressure reminder — assume they got busy, keep it short and friendly',
  },
  {
    key: 'final',
    name: 'Last Call',
    offsetDays: 4,
    tone: 'a final, effortless nudge — make leaving the review feel like one tap, no guilt',
  },
];

export interface Job {
  id: number;
  customer: string;
  job_desc: string | null;
  job_type: string | null; // job | inspection | service
  email: string | null;
  phone: string | null;
  location: string | null;
  technician: string | null;
  completed_at: string | null;
  reviewed: number;
  requested: number;
}

export interface ReviewWorkflowRow {
  id: number;
  job_id: number;
  status: 'active' | 'paused' | 'done' | 'stopped';
  channels: string;
  stage: number;
  started_at: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
}

/** How we describe the completed work in the ask — reads naturally per ServiceTrade work type. */
function workPhrase(job: Job): string {
  const desc = job.job_desc && job.job_desc.trim();
  if (desc) return desc.toLowerCase();
  switch ((job.job_type || 'job').toLowerCase()) {
    case 'inspection':
      return 'inspection';
    case 'service':
      return 'service call';
    default:
      return 'fire protection work';
  }
}

/** Full email body — warm, specific to the work, escalating gently by stage. Deterministic fallback. */
function emailBody(job: Job, stage: Stage): string {
  const work = workPhrase(job);
  const opener =
    stage.key === 'ask'
      ? `Thank you for trusting ${COMPANY.name} with your ${work}${job.location ? ` at ${job.location}` : ''}.`
      : stage.key === 'reminder'
        ? `Just circling back — we know things get busy after a ${work}.`
        : `One last note about your recent ${work} with us.`;
  const ask =
    stage.key === 'final'
      ? `If we earned it, a quick Google review would mean the world and takes about a minute:`
      : `If you have a moment, we'd be grateful for a quick Google review of how it went — it takes about a minute:`;
  return [
    `Hi ${job.customer},`,
    '',
    opener,
    job.technician ? `${job.technician} and the crew appreciated the opportunity.` : '',
    '',
    ask,
    COMPANY.reviewLink,
    '',
    `Your feedback helps other Texas businesses find a licensed & insured life safety team they can trust.`,
    `— ${COMPANY.name} · ${COMPANY.phone}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** SMS body — one screen, brand-safe, review link inline. */
function smsBody(job: Job, stage: Stage): string {
  const work = workPhrase(job);
  const lead =
    stage.key === 'ask'
      ? `Thanks for choosing ${COMPANY.name} for your ${work}!`
      : stage.key === 'reminder'
        ? `${COMPANY.name} here — hope your recent ${work} went great.`
        : `${COMPANY.name}: one quick favor about your ${work}.`;
  return `${lead} Mind leaving us a fast Google review? ${COMPANY.reviewLink} Thank you! Reply STOP to opt out.`;
}

/** Build both channel bodies for this stage. LLM enhances the email when a key is present. */
async function draftStage(job: Job, stage: Stage): Promise<{ email: string; sms: string }> {
  let email = emailBody(job, stage);
  const sms = smsBody(job, stage);
  const result = await chat(
    [
      {
        role: 'system',
        content: `You draft short, on-brand Google review-request emails for ${COMPANY.name} (fire protection & life safety, Texas). Brand voice: ${COMPANY.brandVoice}. This is the "${stage.name}" touch in a polite multi-step sequence; write ${stage.tone}. Reference the specific work. Include this exact review link on its own line: ${COMPANY.reviewLink}. Under 100 words, sign off as the company, never pushy. Output ONLY the email body.`,
      },
      {
        role: 'user',
        content: `Customer: ${job.customer}\nWork type: ${job.job_type || 'job'}\nWork: ${job.job_desc || 'fire protection work'}\nLocation: ${job.location || 'n/a'}\nTechnician: ${job.technician || 'n/a'}`,
      },
    ],
    { fast: true, maxTokens: 320 }
  );
  if (result && result.text) email = result.text;
  return { email, sms };
}

function parseChannels(csv: string): Channel[] {
  return csv
    .split(',')
    .map((c) => c.trim())
    .filter((c): c is Channel => (CHANNELS as readonly string[]).includes(c));
}

/** Enroll a completed job into the staged campaign (the human gate; idempotent — re-enroll reactivates). */
export function enrollJob(jobId: number, channels: Channel[] = ['email', 'sms']): ReviewWorkflowRow {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job | undefined;
  if (!job) throw new Error(`job ${jobId} not found`);
  if (job.reviewed) throw new Error(`job ${jobId} already has a review`);

  const chans = (channels.length ? channels : ['email', 'sms']).join(',');
  db.prepare(
    `INSERT INTO review_workflow (job_id, status, channels, stage, next_run_at)
       VALUES (?, 'active', ?, 0, datetime('now'))
     ON CONFLICT(job_id) DO UPDATE SET
       status = 'active', channels = excluded.channels, next_run_at = datetime('now')`
  ).run(jobId, chans);
  // Marking requested keeps the one-shot "Request Queue" and the campaign from double-listing a job.
  db.prepare('UPDATE jobs SET requested = 1 WHERE id = ?').run(jobId);
  return db.prepare('SELECT * FROM review_workflow WHERE job_id = ?').get(jobId) as ReviewWorkflowRow;
}

/** Pause / resume / stop a campaign. Resume re-arms the next stage for now. */
export function setWorkflowStatus(workflowId: number, status: 'paused' | 'active' | 'stopped'): void {
  const db = getDb();
  if (status === 'active') {
    db.prepare(`UPDATE review_workflow SET status = 'active', next_run_at = datetime('now') WHERE id = ?`).run(
      workflowId
    );
  } else {
    db.prepare(`UPDATE review_workflow SET status = ? WHERE id = ?`).run(status, workflowId);
  }
}

/** Mark a job as reviewed and complete any active campaign — stop asking someone who came through. */
export function completeWorkflowIfReviewed(jobId: number): void {
  const db = getDb();
  db.prepare(`UPDATE jobs SET reviewed = 1 WHERE id = ?`).run(jobId);
  db.prepare(
    `UPDATE review_workflow SET status = 'done'
       WHERE job_id = ? AND status IN ('active','paused')`
  ).run(jobId);
}

export interface CampaignRunResult {
  processed: number; // jobs whose stage fired this cycle
  sent: number; // channel touches actually sent (live integration)
  simulated: number; // channel touches logged only (no integration)
  completed: number; // campaigns that closed (all stages done or a review arrived)
}

/**
 * Run every due stage. Idempotent via next_run_at gating — safe to call on a short interval;
 * it only acts on campaigns whose next stage is due.
 */
export async function runReviewCampaign(opts: { force?: boolean } = {}): Promise<CampaignRunResult> {
  const db = getDb();
  const emailLive = integrationConnected('gmail');
  const smsLive = integrationConnected('sms');

  const due = db
    .prepare(
      `SELECT * FROM review_workflow
        WHERE status = 'active'
          AND (? = 1 OR next_run_at IS NULL OR next_run_at <= datetime('now'))`
    )
    .all(opts.force ? 1 : 0) as ReviewWorkflowRow[];

  const result: CampaignRunResult = { processed: 0, sent: 0, simulated: 0, completed: 0 };

  const logStmt = db.prepare(
    `INSERT INTO review_workflow_log (workflow_id, job_id, stage, stage_key, channel, destination, body, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const wf of due) {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(wf.job_id) as Job | undefined;
    if (!job) {
      db.prepare(`UPDATE review_workflow SET status = 'stopped' WHERE id = ?`).run(wf.id);
      continue;
    }
    // Already reviewed → close the campaign, don't send.
    if (job.reviewed) {
      db.prepare(`UPDATE review_workflow SET status = 'done', last_run_at = datetime('now') WHERE id = ?`).run(wf.id);
      result.completed++;
      continue;
    }
    // Ran past the last stage → complete.
    if (wf.stage >= STAGES.length) {
      db.prepare(`UPDATE review_workflow SET status = 'done', last_run_at = datetime('now') WHERE id = ?`).run(wf.id);
      result.completed++;
      continue;
    }

    const stage = STAGES[wf.stage];
    const stageNo = wf.stage + 1; // human-facing (1-based)
    const { email, sms } = await draftStage(job, stage);
    const channels = parseChannels(wf.channels);

    for (const channel of channels) {
      const dest = channel === 'email' ? job.email : job.phone;
      const body = channel === 'email' ? email : sms;
      let status: string;
      if (!dest) {
        status = 'skipped'; // no address/number on file for this channel
      } else if ((channel === 'email' && emailLive) || (channel === 'sms' && smsLive)) {
        status = 'sent';
        result.sent++;
      } else {
        status = 'simulated';
        result.simulated++;
      }
      logStmt.run(wf.id, job.id, stageNo, stage.key, channel, dest || null, body, status);
    }

    const nextStage = wf.stage + 1;
    if (nextStage >= STAGES.length) {
      // Last stage just fired → campaign is complete.
      db.prepare(
        `UPDATE review_workflow SET stage = ?, status = 'done', last_run_at = datetime('now'), next_run_at = NULL
          WHERE id = ?`
      ).run(nextStage, wf.id);
      result.completed++;
    } else {
      const gapDays = STAGES[nextStage].offsetDays;
      db.prepare(
        `UPDATE review_workflow
            SET stage = ?, last_run_at = datetime('now'),
                next_run_at = datetime('now', ?)
          WHERE id = ?`
      ).run(nextStage, `+${gapDays} day`, wf.id);
    }
    result.processed++;
  }

  return result;
}

export interface ReviewWorkflowView {
  id: number;
  job_id: number;
  customer: string;
  job_type: string | null;
  job_desc: string | null;
  status: string;
  channels: string;
  stage: number;
  stage_name: string;
  total_stages: number;
  last_run_at: string | null;
  next_run_at: string | null;
}

/** Dashboard payload: enrolled campaigns + a recent activity log. */
export function getReviewWorkflowState(): {
  live: boolean;
  emailLive: boolean;
  smsLive: boolean;
  activeCount: number;
  stages: { key: string; name: string; offsetDays: number }[];
  enrolled: ReviewWorkflowView[];
  activity: Record<string, unknown>[];
} {
  const db = getDb();
  const enrolled = (
    db
      .prepare(
        `SELECT w.id, w.job_id, w.status, w.channels, w.stage, w.last_run_at, w.next_run_at,
                j.customer, j.job_type, j.job_desc
           FROM review_workflow w JOIN jobs j ON j.id = w.job_id
          WHERE w.status != 'stopped'
          ORDER BY (w.status='done'), w.next_run_at`
      )
      .all() as (Omit<ReviewWorkflowView, 'stage_name' | 'total_stages'> & { stage: number })[]
  ).map((w) => {
    // stage is the cursor of the NEXT stage to fire; clamp for display of a completed campaign.
    const idx = Math.min(w.stage, STAGES.length - 1);
    return {
      ...w,
      stage_name: w.status === 'done' ? 'Complete' : STAGES[idx].name,
      total_stages: STAGES.length,
    };
  });

  const activity = db
    .prepare(
      `SELECT l.channel, l.stage, l.stage_key, l.status, l.destination, l.created_at, j.customer, j.job_type
         FROM review_workflow_log l JOIN jobs j ON j.id = l.job_id
        ORDER BY l.created_at DESC, l.id DESC LIMIT 20`
    )
    .all() as Record<string, unknown>[];

  const activeCount = enrolled.filter((w) => w.status === 'active').length;
  return {
    live: integrationConnected('gmail') || integrationConnected('sms'),
    emailLive: integrationConnected('gmail'),
    smsLive: integrationConnected('sms'),
    activeCount,
    stages: STAGES.map((s) => ({ key: s.key, name: s.name, offsetDays: s.offsetDays })),
    enrolled,
    activity,
  };
}
