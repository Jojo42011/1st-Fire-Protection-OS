/**
 * The single shell every outbound transactional email renders through.
 *
 * Table-based and inline-styled on purpose: Outlook on Windows renders through Word and
 * ignores max-width on a div, so the 600px column must be a table. Rules are spacer rows
 * with bgcolor rather than CSS borders for the same reason.
 *
 * Design constraints, deliberately narrow so future emails cannot drift:
 *   - one column, white ground, no card, no footer band, no fills
 *   - hairline rules (#EEF0F3) are the only grouping device
 *   - exactly one CTA, always ink (#101828)
 *   - nothing lighter than #667085 carries text
 *   - one radius (6px, the button); it degrades to square in Outlook, which is fine
 */

export interface EmailShellOptions {
  /** Small caps caption at top right: "Houston", "New hire setup", "Invoice 40182". */
  eyebrow?: string | null;
  /** Body HTML, built with the p() / rule() / band() helpers below. */
  body: string;
  /** The single call to action. */
  cta?: { label: string; url: string } | null;
  /** Muted note under the CTA (expiry, fallback URL, service recovery). */
  note?: string | null;
  /** Bold first line of the footer, e.g. "1st Fire Protection Houston". */
  footerName: string;
  /** Second footer line, e.g. "281-333-4444 · 1stfpservices.com". */
  footerMeta?: string | null;
  /** Gold credentials line. Customer-facing mail only; omit on internal. */
  credentials?: string | null;
  /** Required. Why this person received this email. */
  reason: string;
  /** Absolute https URL to the brand logo. When set, the header renders as a centered logo banner
   *  (customer-facing mail); when omitted, the header keeps the compact "1" tile + wordmark. */
  logoUrl?: string | null;
}

const INK = '#101828';
const BODY = '#344054';
const MUTED = '#667085';
const RULE = '#EEF0F3';
const GOLD = '#8A6A2F';
const FONT = `'Helvetica Neue', Helvetica, Arial, sans-serif`;

export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}
export function escapeAttr(s: unknown): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** A body paragraph. Pass pre-escaped HTML; `last` drops the bottom margin. */
export function p(html: string, last = false): string {
  return `<p style="margin:0 0 ${last ? 0 : 18}px;font-family:${FONT};font-size:16px;line-height:1.7;color:${BODY};">${html}</p>`;
}

/** Bold emphasis inside a paragraph. Never use <strong> or weight 700. */
export function em(text: string): string {
  return `<b style="color:${INK};font-weight:600;">${escapeHtml(text)}</b>`;
}

/** A full-width hairline. */
export function rule(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="${RULE}" style="height:1px;line-height:1px;font-size:0;">&nbsp;</td></tr></table>`;
}

/** A rule-bounded detail band: a title and one meta line, no fill, no border, no radius. */
export function band(title: string, meta: string): string {
  return (
    rule() +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 0;font-family:${FONT};">` +
    `<div style="font-size:16px;font-weight:600;color:${INK};">${escapeHtml(title)}</div>` +
    `<div style="font-size:13.5px;color:${MUTED};margin-top:5px;">${escapeHtml(meta)}</div>` +
    `</td></tr></table>` +
    rule()
  );
}

export function renderEmail(o: EmailShellOptions): string {
  const eyebrow = o.eyebrow
    ? `<td align="right" style="font-family:${FONT};font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${MUTED};">${escapeHtml(o.eyebrow)}</td>`
    : '<td></td>';

  const cta = o.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:30px;"><tr>` +
      `<td bgcolor="${INK}" style="border-radius:6px;">` +
      `<a href="${escapeAttr(o.cta.url)}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:14px;font-weight:500;color:#FFFFFF;text-decoration:none;border-radius:6px;">${escapeHtml(o.cta.label)}</a>` +
      `</td></tr></table>`
    : '';

  const note = o.note
    ? `<p style="margin:26px 0 0;font-family:${FONT};font-size:14px;line-height:1.65;color:${MUTED};">${o.note}</p>`
    : '';

  const meta = o.footerMeta
    ? `<div style="font-size:13px;line-height:1.7;color:${MUTED};margin-top:5px;">${escapeHtml(o.footerMeta)}</div>`
    : '';

  const creds = o.credentials
    ? `<div style="font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;color:${GOLD};margin-top:16px;">${escapeHtml(o.credentials)}</div>`
    : '';

  // Header: a centered logo banner when a logo URL is supplied (customer-facing mail), else the
  // compact "1" tile + wordmark. The banner uses alt text so it still identifies the sender when a
  // mail client blocks images by default.
  const sublineText = o.eyebrow ? `1st Fire Protection · ${escapeHtml(o.eyebrow)}` : '1st Fire Protection';
  const header = o.logoUrl
    ? `<tr><td class="pad" style="padding:36px 48px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" style="padding:0 0 2px;"><img src="${escapeAttr(o.logoUrl)}" height="112" alt="1st Fire Protection" style="display:block;height:112px;width:auto;margin:0 auto;border:0;"></td>
        </tr></table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" style="font-family:${FONT};font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${MUTED};padding-top:8px;">${sublineText}</td>
        </tr></table>
      </td></tr>`
    : `<tr><td class="pad" style="padding:44px 48px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="26" style="width:26px;padding-right:11px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="26" height="26" align="center" valign="middle" bgcolor="${INK}" style="width:26px;height:26px;border-radius:6px;font-family:${FONT};font-size:15px;font-weight:700;color:#FFFFFF;line-height:26px;">1</td>
            </tr></table>
          </td>
          <td style="font-family:${FONT};font-size:14.5px;font-weight:600;color:${INK};">1st Fire Protection</td>
          ${eyebrow}
        </tr></table>
      </td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>1st Fire Protection</title>
<style>
  @media only screen and (max-width:480px) {
    .pad { padding-left:24px !important; padding-right:24px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#FFFFFF;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="background:#FFFFFF;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">

  ${header}

  <tr><td class="pad" style="padding:22px 48px 0;">${rule()}</td></tr>

  <tr><td class="pad" style="padding:40px 48px 0;">
    ${o.body}
    ${cta}
    ${note}
  </td></tr>

  <tr><td class="pad" style="padding:44px 48px 0;">${rule()}</td></tr>

  <tr><td class="pad" style="padding:22px 48px 48px;font-family:${FONT};">
    <div style="font-size:13px;font-weight:500;color:${INK};">${escapeHtml(o.footerName)}</div>
    ${meta}
    ${creds}
    <div style="font-size:12px;line-height:1.6;color:${MUTED};margin-top:16px;">${escapeHtml(o.reason)}</div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
