/**
 * Branded HTML for the onboarding intake invite, sent to a hiring manager via Microsoft 365
 * (msGraphMail.sendMail). Email clients strip <style>, so every rule is inline. Kept deliberately
 * simple and light so it renders the same in Outlook, Gmail, and Apple Mail.
 */
export function intakeInviteHtml(o: { managerName?: string | null; hireName?: string | null; role?: string | null; office?: string | null; start?: string | null; url: string }): string {
  const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const hire = esc(o.hireName || 'a new hire');
  const meta = [o.role, o.office].filter(Boolean).map(esc).join(' &middot; ') + (o.start ? ` &middot; starts ${esc(o.start)}` : '');
  const hi = o.managerName ? `Hi ${esc(o.managerName)},` : 'Hi,';
  return `<!doctype html><html><body style="margin:0;background:#f2f4f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0B111C">
  <div style="max-width:520px;margin:0 auto;padding:28px 16px">
    <div style="background:#ffffff;border:1px solid #e7e9ee;border-radius:16px;overflow:hidden">
      <div style="padding:22px 26px 14px;border-bottom:1px solid #eef0f3">
        <div style="font-weight:800;font-size:15px;letter-spacing:-.01em">1st Fire Protection</div>
        <div style="font-weight:500;font-size:12px;color:#697588;margin-top:2px">New hire setup</div>
      </div>
      <div style="padding:22px 26px">
        <p style="margin:0 0 14px;font-size:14px;line-height:1.6">${hi}</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6">The offer for <b>${hire}</b> is signed, so we just need you to set up their equipment and access. It takes about two minutes: pick their computer, software, and what they should be able to get into. No pay or personal details, HR handles those.</p>
        <div style="border:1px solid #e7e9ee;border-radius:12px;padding:14px 15px;margin:0 0 20px;background:#f8fafb">
          <div style="font-weight:800;font-size:15px">${hire}</div>
          <div style="font-weight:500;font-size:12.5px;color:#697588;margin-top:3px">${meta}</div>
        </div>
        <a href="${esc(o.url)}" style="display:inline-block;background:#0E6B4D;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 22px;border-radius:12px">Set up ${hire}</a>
        <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#8a93a3">This link is single-use and expires in 7 days. If the button does not work, paste this into your browser:<br><span style="color:#0E6B4D;word-break:break-all">${esc(o.url)}</span></p>
      </div>
    </div>
    <div style="text-align:center;color:#9aa4b3;font-size:11px;margin-top:14px">You are receiving this because you are the hiring manager for ${hire} at 1st Fire Protection.</div>
  </div></body></html>`;
}
