import { Router } from 'express';
import crypto from 'crypto';
import { getDb } from '../db/index';
import { buildPartnerCrossSell } from '../services/partnerExport';

/**
 * Partner cross-sell channel with the sister company (VDS). Key-gated on its own
 * shared secret (PARTNER_KEY), separate from the metadata-only /api/introspect.
 *   GET  /api/partner/cross-sell   -> 1st FP commercial customers as security leads
 *   POST /api/partner/leads        -> accept VDS accounts as fire/life-safety leads
 *   POST /api/partner/tech-flag    -> a tech flags a site for VDS (highest intent)
 *   POST /api/partner/pull-vds     -> pull VDS's book and file it as fire leads
 *   GET  /partner/flag             -> a phone-friendly flag form for techs
 */

const router = Router();

function tokenMatches(presented: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
function keyFrom(req: any): string {
  const h = req.get('authorization') || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return String(req.query.key || (req.body && req.body.key) || '').trim();
}
function authed(req: any): boolean {
  const expected = process.env.PARTNER_KEY;
  if (!expected) return false;
  const presented = keyFrom(req);
  return !!presented && presented.length === expected.length && tokenMatches(presented, expected);
}

router.get('/api/partner/cross-sell', (req, res) => {
  if (!process.env.PARTNER_KEY) return res.status(503).json({ ok: false, error: 'partner channel disabled: PARTNER_KEY not set' });
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    return res.json({ ok: true, ...buildPartnerCrossSell() });
  } catch (err) {
    console.warn('[partner] cross-sell failed:', (err as Error).message);
    return res.status(500).json({ ok: false, error: 'export failed' });
  }
});

// Accept the sister company's book as fire/life-safety leads (reverse flow).
router.post('/api/partner/leads', (req, res) => {
  if (!process.env.PARTNER_KEY) return res.status(503).json({ ok: false, error: 'partner channel disabled' });
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const items: any[] = Array.isArray(req.body?.accounts) ? req.body.accounts : Array.isArray(req.body?.leads) ? req.body.leads : [];
  if (!items.length) return res.status(400).json({ ok: false, error: 'no accounts provided' });
  const db = getDb();
  const ins = db.prepare(`INSERT INTO leads (name, phone, address, need, status, source) VALUES (?, ?, ?, ?, 'new', ?)`);
  let added = 0;
  for (const a of items) {
    const name = a.company || a.name;
    if (!name) continue;
    const addr = [a.address, a.city, a.state].filter(Boolean).join(', ');
    ins.run(name, a.phone || '', addr, a.need || 'Security customer with no fire/life-safety vendor on file — inspection + service opportunity', 'VDS cross-sell');
    added++;
  }
  return res.json({ ok: true, added });
});

// A 1st FP tech flags a commercial site for VDS while on the job.
router.post('/api/partner/tech-flag', (req, res) => {
  if (!process.env.PARTNER_KEY) return res.status(503).json({ ok: false, error: 'partner channel disabled' });
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const { company, address, contact, note, photo_url, flagged_by } = req.body || {};
  if (!company) return res.status(400).json({ ok: false, error: 'company is required' });
  const db = getDb();
  db.prepare(`INSERT INTO partner_flags (company, address, contact, note, photo_url, flagged_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(company, address || '', contact || '', note || '', photo_url || '', flagged_by || '');
  return res.json({ ok: true });
});

// Pull the VDS book and file each account as a fire/life-safety lead.
router.post('/api/partner/pull-vds', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const url = process.env.PARTNER_VDS_URL;
  const key = process.env.PARTNER_KEY;
  if (!url || !key) return res.status(400).json({ ok: false, error: 'PARTNER_VDS_URL / PARTNER_KEY not configured' });
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    const j: any = await r.json();
    const accounts: any[] = j?.accounts || [];
    const db = getDb();
    const ins = db.prepare(`INSERT INTO leads (name, phone, address, need, status, source) VALUES (?, ?, ?, ?, 'new', 'VDS cross-sell')`);
    let added = 0;
    for (const a of accounts) {
      if (!a.name) continue;
      ins.run(a.name, '', a.location || '', 'Security customer, no fire/life-safety vendor on file');
      added++;
    }
    return res.json({ ok: true, added });
  } catch (err) {
    return res.status(502).json({ ok: false, error: String((err as Error).message).slice(0, 200) });
  }
});

// Phone-friendly flag form for techs. Bookmark /partner/flag?key=<PARTNER_KEY>.
router.get('/partner/flag', (req, res) => {
  if (!process.env.PARTNER_KEY) return res.status(503).send('partner channel disabled');
  const key = String(req.query.key || '');
  if (!authed(req)) return res.status(401).send('Add ?key=... to this link (ask Devon).');
  res.set('content-type', 'text/html; charset=utf-8').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flag a site for VDS</title>
<style>body{font-family:Inter,system-ui,Arial,sans-serif;background:#F5F7F9;color:#1E2D40;margin:0;padding:20px;max-width:520px;margin:0 auto}h1{font-size:20px;font-weight:900;text-transform:uppercase;letter-spacing:.02em}p{color:#5b6675;font-size:13.5px;line-height:1.5}label{display:block;font-weight:700;font-size:12.5px;margin:14px 0 5px}input,textarea{width:100%;padding:11px 12px;border:1px solid #d7dde4;border-radius:9px;font:inherit;font-size:15px;box-sizing:border-box}button{margin-top:18px;width:100%;padding:13px;border:0;border-radius:9px;background:#E53935;color:#fff;font-weight:800;font-size:15px;cursor:pointer}.ok{background:#e9f7ee;border:1px solid #b6e2c6;color:#137a4d;padding:12px;border-radius:9px;margin-top:14px;display:none}.badge{display:inline-block;background:#1E2D40;color:#F5B81B;font-weight:800;font-size:10px;letter-spacing:.14em;padding:4px 8px;border-radius:5px}</style></head>
<body><span class="badge">1ST FP → VDS</span><h1>Flag a site for cameras</h1><p>See a commercial building with old or no cameras while you're on the job? Flag it. It goes straight to VDS as a warm security lead.</p>
<form id="f"><label>Business / site name *</label><input name="company" required placeholder="e.g. Riverwalk Hospitality Group">
<label>Address</label><input name="address" placeholder="Street, city">
<label>Contact (if you have one)</label><input name="contact" placeholder="Name / phone">
<label>What you saw</label><textarea name="note" rows="3" placeholder="No cameras on the dock, old DVR in the office, gate has no access control..."></textarea>
<label>Your name</label><input name="flagged_by" placeholder="Tech name">
<button type="submit">Send to VDS</button></form><div class="ok" id="ok">Sent to VDS. Nice catch.</div>
<script>document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));const r=await fetch('/api/partner/tech-flag?key=${encodeURIComponent(key)}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)});if(r.ok){document.getElementById('ok').style.display='block';e.target.reset();}else{alert('Something went wrong. Try again.');}});</script>
</body></html>`);
});

export default router;
