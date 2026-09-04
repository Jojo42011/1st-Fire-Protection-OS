import fs from 'fs';
import path from 'path';
import { graphToken } from './licenseSources';
import { senderFor } from './mailSenders';
import { getQuote, setStatus, QuoteWithLines } from './quotesBuilder';

/**
 * Email a quote proposal to the customer. Renders the same branded letter the print view shows, as an
 * HTML email with the logo inlined, sent from the configured "proposals" mailbox via the app's existing
 * Microsoft Graph Mail.Send permission. On success the quote is marked sent.
 */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const money = (n: number) => '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const bullets = (s: string | null) => `<ul style="margin:0 0 10px 18px;padding:0">${String(s || '').split(/\n+/).filter(Boolean).map((x) => `<li style="margin:0 0 5px">${esc(x)}</li>`).join('')}</ul>`;

/** The proposal letter as a standalone HTML document (Calibri, per-office letterhead, logo via cid). */
export function renderProposalHtml(d: QuoteWithLines): string {
  const q = d.quote, t = d.totals, br = d.branding;
  const what = q.type === 'Both' ? 'fire sprinkler and fire alarm work' : q.type === 'Fire Alarm' ? 'a fire alarm system' : 'a fire sprinkler system';
  const F = "font-family:Calibri,'Segoe UI',Candara,sans-serif";
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;padding:20px">
  <div style="max-width:720px;margin:0 auto;background:#fff;padding:40px 46px;${F};color:#1f2430;line-height:1.55">
    <div style="display:flex;align-items:center;gap:16px;border-bottom:2px solid #1d2b49;padding-bottom:14px;margin-bottom:18px">
      <img src="cid:fplogo" width="92" alt="1st Fire Protection Services" style="flex:none">
      <div><div style="font-size:19px;font-weight:700;color:#1d2b49">${esc(br.llc)}</div>
        <div style="font-size:11.5px;color:#556;margin-top:3px">${esc(br.street)}<br>${esc(br.cityStateZip)}  ·  ${esc(br.phone)}</div></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:12px;color:#556;font-weight:600;margin:0 0 16px">
      <span>Proposal ${esc(q.number)}</span><span>${new Date().toLocaleDateString('en-US')}</span></div>
    <p style="font-size:13px">To: <b>${esc(q.customer || 'Customer')}</b>${q.contact ? ` · Attn: ${esc(q.contact)}` : ''}</p>
    <p style="font-size:13px">Thank you for the opportunity to provide ${what} for <b>${esc(q.title || 'your project')}</b>. ${esc(br.llc)} proposes to furnish and install the following, in accordance with the applicable NFPA standards and the authority having jurisdiction:</p>
    ${q.scope ? `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#1d2b49;margin:18px 0 6px">Scope of work</h3><p style="font-size:13px">${esc(q.scope).replace(/\n/g, '<br>')}</p>` : ''}
    ${q.inclusions ? `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#1d2b49;margin:18px 0 6px">Included</h3>${bullets(q.inclusions)}` : ''}
    <div style="font-size:19px;font-weight:700;color:#1d2b49;margin:18px 0">Total price: ${money(t.sellPrice)}</div>
    ${q.exclusions ? `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#1d2b49;margin:18px 0 6px">Exclusions</h3>${bullets(q.exclusions)}` : ''}
    <p style="font-size:11px;color:#666">Valid for 30 days. ${esc(q.system_type || 'Wet pipe')} system · ${esc(q.hazard || '')}${q.sf ? ` · ${Number(q.sf).toLocaleString()} sq ft` : ''}.</p>
    <div style="margin-top:22px;border-top:1px solid #999;padding-top:12px;font-size:12px">
      <b>Acceptance</b>
      <p style="font-size:11px;color:#555;margin:6px 0 14px">Signature below authorizes ${esc(br.llc)} to proceed under the terms of this proposal.</p>
      <table style="width:100%;font-size:11px;color:#666"><tr>
        <td style="padding-right:24px"><div style="border-bottom:1px solid #333;height:26px"></div>Authorized signature</td>
        <td><div style="border-bottom:1px solid #333;height:26px"></div>Date</td></tr></table>
    </div>
  </div></body></html>`;
}

function logoAttachment(): { b64: string; name: string; ctype: string } | null {
  try {
    const p = path.resolve(__dirname, '../../../client/brand/logo-proposal.png');
    return { b64: fs.readFileSync(p).toString('base64'), name: 'logo.png', ctype: 'image/png' };
  } catch { return null; }
}

export async function sendProposal(quoteId: number, to: string): Promise<{ ok: boolean; error?: string }> {
  const dest = String(to || '').trim();
  if (!dest || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest)) return { ok: false, error: 'A valid recipient email is required.' };
  const d = getQuote(quoteId);
  if (!d) return { ok: false, error: 'quote not found' };
  let token: string | null = null;
  try { token = await graphToken(); } catch (e) { return { ok: false, error: `Microsoft 365 mail is not connected (${(e as Error).message.slice(0, 120)}).` }; }
  if (!token) return { ok: false, error: 'Microsoft 365 mail is not connected.' };
  const sender = senderFor('proposals') || senderFor('notifications');
  if (!sender || !sender.address) return { ok: false, error: 'No sending mailbox configured. Set the "Quote proposals" sender in Integrations.' };

  const html = renderProposalHtml(d);
  const logo = logoAttachment();
  const message: any = {
    subject: `Proposal ${d.quote.number} · ${d.branding.llc}`,
    body: { contentType: 'HTML', content: html },
    toRecipients: [{ emailAddress: { address: dest } }],
    from: { emailAddress: { address: sender.address } },
  };
  if (logo) message.attachments = [{ '@odata.type': '#microsoft.graph.fileAttachment', name: logo.name, contentType: logo.ctype, isInline: true, contentId: 'fplogo', contentBytes: logo.b64 }];

  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender.address)}/sendMail`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
    if (!res.ok) return { ok: false, error: `send failed (${res.status}): ${(await res.text()).slice(0, 200)}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }

  setStatus(quoteId, 'sent');
  return { ok: true };
}
