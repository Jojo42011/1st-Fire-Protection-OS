import { resendEnabled, telnyxEnabled } from '../config/comms';
import { COMPANY } from '../config/constants';

/**
 * Outbound messaging — Resend for email, Telnyx for SMS. Provider-agnostic result.
 * Graceful degradation is mandatory: with no key the send is a no-op that returns
 * { sent:false, provider:'none' } so the caller can leave the reminder 'queued'.
 * Never throws on a missing key.
 */

export interface SendResult {
  sent: boolean;
  provider: 'resend' | 'telnyx' | 'none';
  id?: string; // provider message id
  error?: string;
}

/** Send an email via Resend. No-op (sent:false) when RESEND_* isn't configured. */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  body: string;
}): Promise<SendResult> {
  if (!resendEnabled()) return { sent: false, provider: 'none' };
  if (!opts.to) return { sent: false, provider: 'none', error: 'no recipient email' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL, // e.g. "1st Fire Protection <billing@1stfpcompanies.com>"
        to: [opts.to],
        subject: opts.subject,
        text: opts.body,
        reply_to: COMPANY.email,
      }),
    });
    if (!res.ok) return { sent: false, provider: 'resend', error: `resend ${res.status}: ${await res.text()}` };
    const data = (await res.json()) as { id?: string };
    return { sent: true, provider: 'resend', id: data.id };
  } catch (err) {
    return { sent: false, provider: 'resend', error: (err as Error).message };
  }
}

/** Send an SMS via Telnyx. No-op (sent:false) when TELNYX_* isn't configured. */
export async function sendSms(opts: { to: string; body: string }): Promise<SendResult> {
  if (!telnyxEnabled()) return { sent: false, provider: 'none' };
  if (!opts.to) return { sent: false, provider: 'none', error: 'no recipient phone' };

  try {
    const payload: Record<string, unknown> = {
      from: process.env.TELNYX_FROM_NUMBER,
      to: opts.to,
      text: opts.body,
    };
    if (process.env.TELNYX_MESSAGING_PROFILE_ID) {
      payload.messaging_profile_id = process.env.TELNYX_MESSAGING_PROFILE_ID;
    }
    const res = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { sent: false, provider: 'telnyx', error: `telnyx ${res.status}: ${await res.text()}` };
    const data = (await res.json()) as { data?: { id?: string } };
    return { sent: true, provider: 'telnyx', id: data.data?.id };
  } catch (err) {
    return { sent: false, provider: 'telnyx', error: (err as Error).message };
  }
}

/** Route a reminder to the right provider by channel. */
export async function sendMessage(
  channel: 'email' | 'sms',
  to: string,
  subject: string,
  body: string
): Promise<SendResult> {
  return channel === 'email' ? sendEmail({ to, subject, body }) : sendSms({ to, body });
}
