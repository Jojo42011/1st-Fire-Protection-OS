import { ToolDef } from '../services/llm';
import { AGENTS } from '../config/agents';
import { draftInvoiceReminder, getReceivablesSummary } from '../services/invoiceAgent';
import { draftReviewRequest, draftReviewReply, getReputationSummary } from '../services/reviewAgent';
import { getCallMetrics, captureLead, bookInspection, Lead } from '../services/receptionist';
import { getEstimatingSummary, draftQuote } from '../services/estimatorAgent';
import { getPipelineSummary, draftFollowup } from '../services/closerAgent';
import { getRecurringSummary, draftRenewal, proposePlan } from '../services/planAgent';
import { getScheduleSummary, proposeSchedule, draftReminder } from '../services/dispatchAgent';
import { getCostingSummary, draftChangeOrder } from '../services/costingAgent';

/**
 * Function-tool defs + executeTool(). At minimum: open_tab (navigation), get_agent_status,
 * plus one tool per agent action. Gated actions only DRAFT — they never send/publish/charge.
 */

// Agent tabs come from the registry; the CRM surfaces (Accounts/Pipeline/ServiceTrade
// sync) are screens, not employees, so they're navigable via open_tab without being in AGENTS.
const TAB_KEYS = AGENTS.map((a) => a.key).concat('integrations', 'crm', 'pipeline', 'sync');

export const TOOLS: ToolDef[] = [
  {
    name: 'open_tab',
    description: 'Open a dashboard tab on the operator screen (navigation). Reversible/free.',
    parameters: {
      type: 'object',
      properties: {
        tab: { type: 'string', enum: TAB_KEYS, description: 'Which tab to open' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'get_agent_status',
    description: 'Get live status + key metrics for all AI employees.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_receivables_summary',
    description: 'Summarize outstanding invoices (total owed, count, aging buckets, collected this month).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'draft_invoice_reminder',
    description: 'Draft a payment reminder for an overdue invoice. GATED — draft only, awaits human approval.',
    parameters: {
      type: 'object',
      properties: { invoice_id: { type: 'number' } },
      required: ['invoice_id'],
    },
  },
  {
    name: 'get_estimating_summary',
    description: 'Summarize the Estimator: quotes sent this month, dollars quoted, time-to-quote, win rate, takeoffs waiting on a price.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'draft_quote',
    description: 'Price a read takeoff into a quote off the rate card. GATED — draft only, awaits human approval.',
    parameters: {
      type: 'object',
      properties: { takeoff_id: { type: 'number' } },
      required: ['takeoff_id'],
    },
  },
  {
    name: 'get_pipeline_summary',
    description: 'Summarize open quotes the Closer is chasing: value at risk, stalled count, win rate, and why quotes are lost.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'draft_followup',
    description: 'Draft the next-tier follow-up (nudge/value/last call) for an open quote. GATED — draft only, awaits human approval.',
    parameters: {
      type: 'object',
      properties: { quote_id: { type: 'number' } },
      required: ['quote_id'],
    },
  },
  {
    name: 'get_recurring_summary',
    description: 'Summarize service plans: recurring revenue under agreement, agreements lapsing soon, visits due.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'draft_renewal',
    description: 'Draft a renewal for a service agreement that is lapsing. GATED — draft only, awaits human approval.',
    parameters: { type: 'object', properties: { agreement_id: { type: 'number' } }, required: ['agreement_id'] },
  },
  {
    name: 'propose_plan',
    description: 'Propose a recurring service plan from a finished one-time job. GATED — draft only, awaits human approval.',
    parameters: { type: 'object', properties: { candidate_index: { type: 'number' } }, required: ['candidate_index'] },
  },
  {
    name: 'get_schedule_summary',
    description: 'Summarize the Dispatcher: jobs today, crew utilization, no-show rate, open slots, and the crew-week schedule.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_schedule',
    description: 'Propose the best crew + slot for a waitlisted job, with the reason. GATED — draft only, awaits human approval.',
    parameters: { type: 'object', properties: { wait_id: { type: 'number' } }, required: ['wait_id'] },
  },
  {
    name: 'draft_reminder',
    description: 'Draft the customer reminder text for an appointment. GATED — draft only, awaits human approval.',
    parameters: { type: 'object', properties: { appointment_id: { type: 'number' } }, required: ['appointment_id'] },
  },
  {
    name: 'get_costing_summary',
    description: 'Summarize Job Costing: portfolio margin, jobs losing money, best job, and where margin bleeds. Margin is computed, never stored.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'draft_change_order',
    description: 'Draft a change order for a job that ran past its quote (out-of-scope overrun). GATED — draft only, awaits human approval.',
    parameters: { type: 'object', properties: { job_id: { type: 'number' } }, required: ['job_id'] },
  },
  {
    name: 'get_reputation_summary',
    description: 'Summarize reputation (avg rating, total reviews, this-month delta, star distribution).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'draft_review_request',
    description: 'Draft a review request for a completed job. GATED — draft only.',
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'number' } },
      required: ['job_id'],
    },
  },
  {
    name: 'draft_review_reply',
    description: 'Draft a public reply to an incoming review. GATED — draft only.',
    parameters: {
      type: 'object',
      properties: { review_id: { type: 'number' } },
      required: ['review_id'],
    },
  },
  {
    name: 'capture_lead',
    description: 'Capture a lead from a call/message (name, phone, address, need). Free/in-house.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
        need: { type: 'string' },
      },
    },
  },
  {
    name: 'book_inspection',
    description: 'Book an inspection/service visit for a lead. Free/in-house (reversible).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
        need: { type: 'string' },
      },
    },
  },
  {
    name: 'transfer_to_human',
    description: 'Flag the call/lead for immediate human handoff (emergency or out of scope).',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' } },
    },
  },
];

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  navigate?: string; // tab key to open in the shell
  message: string;
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'open_tab': {
        const tab = String(args.tab || '').toLowerCase();
        if (!TAB_KEYS.includes(tab)) return { ok: false, message: `Unknown tab: ${tab}` };
        return { ok: true, navigate: tab, message: `Opening ${tab}.` };
      }
      case 'get_agent_status': {
        const status = AGENTS.map((a) => ({ name: a.name, role: a.role, status: a.status }));
        return { ok: true, data: status, message: 'Team status ready.' };
      }
      case 'get_receivables_summary': {
        const s = getReceivablesSummary();
        return {
          ok: true,
          data: s,
          message: `$${s.totalOutstanding.toFixed(0)} outstanding across ${s.count} invoices; $${s.collectedThisMonth.toFixed(0)} collected this month.`,
        };
      }
      case 'draft_invoice_reminder': {
        const r = await draftInvoiceReminder(Number(args.invoice_id));
        return { ok: true, data: r, navigate: 'invoices', message: `Drafted a ${r.tier} reminder — awaiting your approval.` };
      }
      case 'get_estimating_summary': {
        return { ok: true, data: getEstimatingSummary(), message: 'Estimator summarized.' };
      }
      case 'draft_quote': {
        const r = draftQuote(Number(args.takeoff_id));
        return { ok: true, data: r, navigate: 'estimator', message: `Drafted quote ${r.number} ($${r.total.toLocaleString('en-US')}) — awaiting your approval.` };
      }
      case 'get_pipeline_summary': {
        return { ok: true, data: getPipelineSummary(), message: 'Open quotes summarized.' };
      }
      case 'draft_followup': {
        const r = draftFollowup(Number(args.quote_id));
        return { ok: true, data: r, navigate: 'closer', message: `Drafted a ${r.tier.replace('_', ' ')} follow-up (${r.value} on the line) — awaiting your approval.` };
      }
      case 'get_recurring_summary': {
        return { ok: true, data: getRecurringSummary(), message: 'Service plans summarized.' };
      }
      case 'draft_renewal': {
        const r = draftRenewal(Number(args.agreement_id));
        return { ok: true, data: r, navigate: 'plans', message: 'Drafted a renewal — awaiting your approval.' };
      }
      case 'propose_plan': {
        const r = proposePlan(Number(args.candidate_index));
        return { ok: true, data: r, navigate: 'plans', message: `Proposed a plan for ${r.customer} — awaiting your approval.` };
      }
      case 'get_schedule_summary': {
        return { ok: true, data: getScheduleSummary(), navigate: 'dispatch', message: 'Schedule summarized.' };
      }
      case 'propose_schedule': {
        const r = proposeSchedule(Number(args.wait_id));
        return { ok: true, data: r, navigate: 'dispatch', message: `Proposed ${r.crew} — awaiting your approval.` };
      }
      case 'draft_reminder': {
        const r = draftReminder(Number(args.appointment_id));
        return { ok: true, data: r, navigate: 'dispatch', message: 'Drafted a reminder — awaiting your approval.' };
      }
      case 'get_costing_summary': {
        return { ok: true, data: getCostingSummary(), navigate: 'costing', message: 'Job margins summarized.' };
      }
      case 'draft_change_order': {
        const r = draftChangeOrder(Number(args.job_id));
        return { ok: true, data: r, navigate: 'costing', message: `Drafted a ${r.amount} change order — awaiting your approval.` };
      }
      case 'get_reputation_summary': {
        const s = getReputationSummary();
        return {
          ok: true,
          data: s,
          message: `${s.avgRating.toFixed(1)}★ across ${s.totalReviews} reviews (${s.thisMonthDelta} this month).`,
        };
      }
      case 'draft_review_request': {
        const r = await draftReviewRequest(Number(args.job_id));
        return { ok: true, data: r, navigate: 'reviews', message: 'Drafted a review request — awaiting your approval.' };
      }
      case 'draft_review_reply': {
        const r = await draftReviewReply(Number(args.review_id));
        return { ok: true, data: r, navigate: 'reviews', message: 'Drafted a reply — awaiting your approval.' };
      }
      case 'capture_lead': {
        const id = captureLead(args as Lead);
        return { ok: true, data: { id }, navigate: 'calls', message: `Captured lead #${id}.` };
      }
      case 'book_inspection': {
        const id = bookInspection(args as Lead);
        return { ok: true, data: { id }, navigate: 'calls', message: `Booked an inspection (lead #${id}).` };
      }
      case 'transfer_to_human': {
        return { ok: true, message: `Flagged for a human: ${args.reason || 'handoff requested'}.` };
      }
      default:
        return { ok: false, message: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, message: `Tool ${name} failed: ${(err as Error).message}` };
  }
}
