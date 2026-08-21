/**
 * Branded HTML for the onboarding intake invite, sent to a hiring manager via Microsoft 365
 * (msGraphMail.sendMail). Renders through the shared transactional email shell so it matches the
 * customer-facing mail: one column, white ground, hairline rules, a single ink CTA. Internal mail,
 * so no credentials line.
 */
import { renderEmail, p, em, band, escapeHtml } from './emailShell';

export function intakeInviteHtml(o: {
  managerName?: string | null; hireName?: string | null; role?: string | null;
  office?: string | null; start?: string | null; url: string;
}): string {
  const hire = o.hireName || 'a new hire';
  const meta = [o.role, o.office].filter(Boolean).join(' · ') + (o.start ? ` · starts ${o.start}` : '');
  const hi = o.managerName ? `Hi ${escapeHtml(o.managerName)},` : 'Hi,';

  return renderEmail({
    eyebrow: 'New hire setup',
    body:
      p(hi) +
      p(`The offer for ${em(hire)} is signed, so we just need you to set up their equipment and access. It takes about two minutes: pick their computer, software, and what they should be able to get into. No pay or personal details, HR handles those.`) +
      band(hire, meta),
    cta: { label: `Set up ${hire}`, url: o.url },
    note: `This link is single-use and expires in 7 days. If the button does not work, paste this into your browser:<br><span style="color:#475467;word-break:break-all;">${escapeHtml(o.url)}</span>`,
    footerName: '1st Fire Protection Services, LLC',
    footerMeta: 'Sent from the onboarding mailbox',
    credentials: null,
    reason: `You are receiving this because you are the hiring manager for ${hire} at 1st Fire Protection.`,
  });
}
