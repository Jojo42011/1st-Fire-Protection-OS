import { Router } from 'express';
import { graphToken } from '../services/licenseSources';

/**
 * Teams Voice discovery analytics. Pulls PSTN call detail records from Microsoft Graph
 * (getPstnCalls) using the existing Entra app credentials, and aggregates them into the
 * reception picture: volume, direction, per-office inbound, hour-of-day, and daily counts.
 * Read-only. Used to size the AI-receptionist opportunity before building it.
 */
const router = Router();

// The office main (auto-attendant) numbers, so inbound calls can be labeled by office.
const OFFICE_NUMBERS: Record<string, string> = {
  '+12103773473': 'San Antonio',
  '+13463728684': 'Houston',
  '+15123129768': 'Austin',
  '+19799786563': 'College Station',
  '+19566823473': 'McAllen',
  '+18062167634': 'Lubbock',
  '+12543273744': 'Waco',
  '+17262235130': 'Accounting',
};

router.get('/api/teams/pstn-analytics', async (req, res) => {
  try {
    const token = await graphToken();
    if (!token) return res.status(400).json({ ok: false, error: 'no Graph token (MS_GRAPH_* not set)' });
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    const base = 'https://graph.microsoft.com/v1.0/communications/callRecords';
    let url: string | null =
      `${base}/getPstnCalls(fromDateTime=${from.toISOString()},toDateTime=${to.toISOString()})`;

    const calls: any[] = [];
    let guard = 0;
    while (url && guard++ < 60) {
      const r: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return res.status(400).json({ ok: false, status: r.status, error: (await r.text()).slice(0, 600), hint: r.status === 403 ? 'grant admin consent for CallRecords.Read.All' : undefined });
      const j: any = await r.json();
      for (const c of j.value || []) calls.push(c);
      url = j['@odata.nextLink'] || null;
    }

    const orgSet = new Set(Object.keys(OFFICE_NUMBERS));
    const byOffice: Record<string, number> = {};
    const byHourCentral = new Array(24).fill(0); // approx CST (UTC-6)
    const byDate: Record<string, number> = {};
    let inbound = 0, outbound = 0, durSum = 0, durN = 0;

    for (const c of calls) {
      const callee = String(c.calleeNumber || '');
      const caller = String(c.callerNumber || '');
      const isInbound = orgSet.has(callee);
      const isOutbound = orgSet.has(caller);
      if (isInbound) {
        inbound++;
        byOffice[OFFICE_NUMBERS[callee]] = (byOffice[OFFICE_NUMBERS[callee]] || 0) + 1;
        const d = new Date(c.startDateTime);
        const h = (d.getUTCHours() + 24 - 6) % 24;
        byHourCentral[h]++;
        const key = new Date(d.getTime() - 6 * 3600000).toISOString().slice(0, 10);
        byDate[key] = (byDate[key] || 0) + 1;
      } else if (isOutbound) outbound++;
      const dur = Number(c.duration);
      if (isFinite(dur) && dur > 0) { durSum += dur; durN++; }
    }

    const dayCount = Object.keys(byDate).length || 1;
    res.json({
      ok: true,
      window: { days, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      totalPstnCalls: calls.length,
      inbound, outbound,
      inboundPerDayAvg: Math.round((inbound / dayCount) * 10) / 10,
      inboundByOffice: Object.fromEntries(Object.entries(byOffice).sort((a, b) => b[1] - a[1])),
      inboundByHourCentral: byHourCentral,
      avgDurationSec: durN ? Math.round(durSum / durN) : 0,
      distinctDays: dayCount,
      sample: calls.slice(0, 3),
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
