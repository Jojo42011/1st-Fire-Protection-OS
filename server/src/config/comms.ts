/**
 * Comms config for the Invoice Collector's reminder workflow.
 * Email is sent via Resend, SMS via Telnyx. Both no-op cleanly without their keys
 * (graceful degradation) — a reminder that can't send is left 'queued' for a human.
 */

/** The reminder cadence, in days after job completion. day 1 → 3 → 5 → 7. */
export const REMINDER_STEPS: number[] = (() => {
  const raw = process.env.INVOICE_REMINDER_DAYS;
  if (!raw) return [1, 3, 5, 7];
  const parsed = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length ? parsed : [1, 3, 5, 7];
})();

/** Escalating tone by how far into the sequence a step is. */
export function tierForStep(day: number): { tier: string; tone: string } {
  if (day >= 7) return { tier: 'final', tone: 'a firm final notice — professional, not hostile' };
  if (day >= 5) return { tier: 'firm', tone: 'a firmer follow-up — clear and direct' };
  return { tier: 'friendly', tone: 'a friendly nudge — warm and low-pressure' };
}

export function resendEnabled(): boolean {
  return !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

export function telnyxEnabled(): boolean {
  return !!(process.env.TELNYX_API_KEY && process.env.TELNYX_FROM_NUMBER);
}

/** Can a given channel actually leave the building right now? */
export function channelLive(channel: 'email' | 'sms'): boolean {
  return channel === 'email' ? resendEnabled() : telnyxEnabled();
}

/** ServiceTrade (field service system of record) connected? */
export function serviceTradeEnabled(): boolean {
  return !!process.env.SERVICETRADE_TOKEN;
}
