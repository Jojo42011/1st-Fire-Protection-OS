/**
 * Scheduled reports: deliver a saved report by email on a cadence (weekly today).
 *
 * A saved report can carry a schedule + recipient. runDueReports() finds the ones that are due,
 * computes the metric under the report OWNER'S authorization (via a headless context, so a scheduled
 * run never sees more than the owner could), renders a small HTML email, sends it through Microsoft
 * Graph, and advances next_run_at. Nothing is sent if mail is not configured; the report just stays
 * due and says so, so the UI never claims a delivery that did not happen.
 */
import { getDb } from '../db/index';
import { runMetric, metricByOffice, MetricResult } from '../os/metrics';
import { resolvePeriod } from '../os/period';
import { contextForUser } from '../os/scope';
import { resolveAppUser } from '../people/authz';
import { mailConfigured, sendMail } from './msGraphMail';

const WEEK_MS = 7 * 86400000;

/** The next weekly delivery time from a base (defaults to now). */
export function nextWeeklyRun(fromIso?: string): string {
  const base = fromIso ? new Date(fromIso).getTime() : Date.now();
  return new Date(base + WEEK_MS).toISOString();
}

function fmtValue(v: number, unit: string): string {
  if (unit === 'usd') { const s = v < 0 ? '-' : ''; const n = Math.abs(v); return s + '$' + (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : Math.round(n)); }
  if (unit === 'percent') return v + '%';
  return (Number(v) || 0).toLocaleString('en-US');
}
function esc(t: any): string { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** Compute a saved report and render its email HTML under the owner's scope. */
export function renderReport(name: string, cfg: any, ownerEmail: string): { subject: string; html: string } | { error: string } {
  const ctx = contextForUser(resolveAppUser(ownerEmail));
  const range = resolvePeriod(cfg.period, { start: cfg.start, end: cfg.end });
  const metricKey = cfg.metric || 'open_pipeline';

  let body = '';
  let headline = '';
  if (cfg.groupBy === 'office') {
    const rows = metricByOffice(metricKey, ctx, { range });
    if (!rows.length) return { error: 'no_data' };
    const unit = 'count';
    const total = rows.reduce((s, r) => s + r.value, 0);
    headline = `${rows.length} offices`;
    body =
      '<table style="border-collapse:collapse;width:100%;font-size:14px">' +
      rows
        .map(
          (r) =>
            `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${esc(r.label)}</td>` +
            `<td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600">${esc(fmtValue(r.value, unit))}</td></tr>`
        )
        .join('') +
      '</table>';
  } else {
    const r = runMetric(metricKey, ctx, { office: cfg.office, range });
    if ('error' in r) return { error: r.error };
    const m = r as MetricResult;
    headline = fmtValue(m.value, m.unit);
    body =
      `<div style="font-size:34px;font-weight:800;color:#0E1420">${esc(fmtValue(m.value, m.unit))}</div>` +
      `<div style="font-size:13px;color:#5E6779;margin-top:4px">${esc(m.label)}${m.companyWide ? ' (company-wide)' : ''} - source: ${esc(m.source)}</div>`;
  }

  const subject = `1st FP OS: ${name} (${range.label})`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0E1420">` +
    `<div style="font-weight:800;font-size:16px">${esc(name)}</div>` +
    `<div style="font-size:12px;color:#5E6779;margin:2px 0 16px">Weekly report - ${esc(range.label)}</div>` +
    body +
    `<div style="font-size:11px;color:#98A0B0;margin-top:20px;line-height:1.5">Operational figures from ServiceTrade and the invoice ledger. Projected values are estimates, never booked revenue. Revenue, margin and cash await Sage Intacct. Reply to this email to change or stop this report.</div>` +
    `</div>`;
  return { subject, html };
}

interface DueRow { id: number; owner_email: string; name: string; config_json: string; recipient: string; next_run_at: string | null }

/** Deliver every report that is due. Returns a small summary for logging. */
export async function runDueReports(nowIso?: string): Promise<{ due: number; sent: number; skipped: number }> {
  const db = getDb();
  const now = nowIso || new Date().toISOString();
  let rows: DueRow[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, owner_email, name, config_json, recipient, next_run_at FROM saved_reports
           WHERE schedule = 'weekly' AND recipient IS NOT NULL AND recipient != ''
             AND (next_run_at IS NULL OR next_run_at <= ?)`
      )
      .all(now) as DueRow[];
  } catch { return { due: 0, sent: 0, skipped: 0 }; }
  if (!rows.length) return { due: 0, sent: 0, skipped: 0 };

  // If mail is not configured we cannot deliver; leave the reports due and honest rather than
  // advancing next_run_at as if they went out.
  if (!mailConfigured()) return { due: rows.length, sent: 0, skipped: rows.length };

  let sent = 0;
  for (const r of rows) {
    const cfg = (() => { try { return JSON.parse(r.config_json); } catch { return {}; } })();
    const rendered = renderReport(r.name, cfg, r.owner_email);
    if ('error' in rendered) continue; // no data / bad metric: try again next cycle
    const out = await sendMail(r.recipient, rendered.subject, rendered.html, '1st Fire Protection');
    if (out.ok) {
      db.prepare(`UPDATE saved_reports SET last_sent_at = ?, next_run_at = ? WHERE id = ?`).run(now, nextWeeklyRun(now), r.id);
      sent++;
    }
  }
  return { due: rows.length, sent, skipped: rows.length - sent };
}
