/**
 * A small standalone page in the website look (1stfpservices.com), for the pages the server builds
 * itself: approval links, "Mark done" links, and "No access". Same as the app's website theme: Inter,
 * ink on the #f5f5f7 canvas, a white 22px card, red pill primary buttons that rise with a red glow,
 * red focus rings, and the shared website motion (a slow blur-up reveal). Brand assets are public,
 * so it works without a session.
 *
 * Classes for the body: h1, .sub, .box (b inside for the title), label, textarea, .row, button (white),
 * button.go (red, the main action), a.btn (white link button), .done / .ok (green), .no (red).
 */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export function brandPage(title: string, body: string, opts: { logo?: boolean } = {}): string {
  const logo = opts.logo === false ? '' : `<div class="mark"><img src="/brand/logo-240.png" alt="" />1st Fire Protection</div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="icon" type="image/png" href="/brand/logo-240.png">
<link rel="stylesheet" href="/brand/site-motion.css">
<script src="/brand/site-motion.js" defer></script>
<style>
@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url('/brand/fonts/InterVariable-latin.woff2') format('woff2')}
:root{--ink:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--canvas:#f5f5f7;--brand:#d62d2a;--brand-hover:#e0332f;--link:#0066cc;--ease-fp:cubic-bezier(.2,.7,.2,1)}
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,-apple-system,"Segoe UI",sans-serif;background:var(--canvas);color:var(--ink);-webkit-font-smoothing:antialiased}
main{width:min(480px,calc(100% - 32px));margin:24px auto;padding:30px;box-sizing:border-box;background:#fff;border-radius:22px;box-shadow:0 0 0 1px rgba(0,0,0,.06),0 30px 60px -30px rgba(29,29,31,.3)}
.mark{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px;letter-spacing:-.01em;margin:0 0 20px}
.mark img{width:26px;height:26px;border-radius:7px}
h1{font-weight:800;font-size:22px;line-height:1.2;letter-spacing:-.025em;margin:0 0 8px}
.sub{color:var(--muted);margin:0 0 18px;line-height:1.55;font-size:15px}
.box{background:var(--canvas);border-radius:12px;padding:12px 14px;margin:0 0 18px;font-size:14px;line-height:1.5}
.pre{white-space:pre-wrap}
.box b{display:block;font-size:15px}
label{font-size:13px;color:var(--muted)}
textarea{width:100%;box-sizing:border-box;min-height:74px;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font:inherit;font-size:15px;margin:6px 0 12px;
  transition:border-color .2s cubic-bezier(.4,0,.2,1),box-shadow .2s cubic-bezier(.4,0,.2,1)}
textarea:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 4px rgba(214,45,42,.14)}
.row{display:flex;gap:10px;flex-wrap:wrap}
button,a.btn{flex:1;display:block;width:100%;box-sizing:border-box;text-align:center;min-height:46px;line-height:46px;padding:0 18px;border-radius:980px;
  font:inherit;font-size:15px;font-weight:700;cursor:pointer;border:0;background:#fff;color:var(--ink);box-shadow:inset 0 0 0 1px var(--line);text-decoration:none;
  transition:transform .35s var(--ease-fp),box-shadow .35s var(--ease-fp),background-color .35s var(--ease-fp)}
.row button{width:auto}
button:hover,a.btn:hover{transform:translateY(-2px);box-shadow:inset 0 0 0 1px var(--ink)}
button.go{background:var(--brand);color:#fff;box-shadow:0 10px 24px -8px rgba(214,45,42,.5)}
button.go:hover{background:var(--brand-hover);box-shadow:0 14px 34px -8px rgba(214,45,42,.65),0 0 0 6px rgba(214,45,42,.14)}
button:active,a.btn:active{transform:translateY(0);transition-duration:.12s}
a.btn{margin-top:10px}
a{color:var(--link)}
.done,.ok{color:#1a8a4a;font-weight:700}.no{color:#b8231f;font-weight:700}
@media (prefers-reduced-motion:reduce){button,a.btn{transition:none}button:hover,a.btn:hover{transform:none}}
</style></head><body><main data-reveal="0">${logo}${body}</main></body></html>`;
}
