import { Router } from 'express';
import { getDb } from '../db/index';
import { CLOSED_STATUSES, AVG_REPAIR_USD } from '../services/deficiencySync';

/**
 * Per-office scoreboard. One comparative row per office, built entirely from the local mirror so
 * it is fast: win rate, open pipeline, jobs, recurring plans, open-deficiency backlog, and whether
 * an on-call person is covering the after-hours line right now. This is the "one operating system
 * over the whole company" view: the offices ranked side by side on the numbers that move money.
 */
const router = Router();

const WON = ['accepted', 'approved', 'won'];
const LOST = ['rejected', 'lost', 'canceled', 'cancelled', 'expired', 'void'];
const OPEN = ['draft', 'submitted', 'pending', 'reviewed', 'contingent'];
const list = (a: string[]) => a.map((s) => `'${s}'`).join(',');
const OPEN_DEF = `lower(status) NOT IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(',')})`;

/** ServiceTrade full office name -> friendly label (mirrors the office switcher). */
function shortLabel(o: string): string {
  const s = (o || '').replace(/^1st FP\s*/i, '').replace(/\s*LLC$/i, '').trim();
  return /^services$/i.test(s) ? 'San Antonio' : s || o;
}

router.get('/api/scorecard', (_req, res) => {
  const db = getDb();
  const scalar = (sql: string, o: string): number => {
    try {
      return (db.prepare(sql).get({ office: o }) as { v: number }).v || 0;
    } catch {
      return 0;
    }
  };

  // the office universe: same source as /api/offices (schedule + quotes), minus the sister company
  const offices = (
    db
      .prepare(
        `SELECT DISTINCT o FROM (
           SELECT office AS o FROM sched_appointments WHERE office IS NOT NULL AND office != ''
           UNION SELECT office AS o FROM quotes WHERE source='servicetrade' AND office IS NOT NULL AND office != ''
         ) ORDER BY o`
      )
      .all() as { o: string }[]
  )
    .map((r) => r.o)
    .filter((o) => !/video digital|vds/i.test(o));

  // who is on call right now, per short-label office
  const onCallRows = db
    .prepare(
      `SELECT office FROM oncall_shifts WHERE date('now','localtime') >= starts_on AND date('now','localtime') < ends_on`
    )
    .all() as { office: string }[];
  const onCallNow = new Set(onCallRows.map((r) => r.office));

  const rows = offices.map((office) => {
    const won = scalar(`SELECT COUNT(*) AS v FROM quotes WHERE source='servicetrade' AND office=@office AND lower(stage) IN (${list(WON)})`, office);
    const lost = scalar(`SELECT COUNT(*) AS v FROM quotes WHERE source='servicetrade' AND office=@office AND lower(stage) IN (${list(LOST)})`, office);
    const decided = won + lost;
    const pipelineCents = scalar(`SELECT COALESCE(SUM(amount_cents),0) AS v FROM quotes WHERE source='servicetrade' AND office=@office AND lower(stage) IN (${list(OPEN)})`, office);
    const jobs = scalar(`SELECT COUNT(*) AS v FROM crm_jobs WHERE source='servicetrade' AND office_name=@office`, office);
    const plans = scalar(`SELECT COUNT(*) AS v FROM service_recurrences WHERE office=@office`, office);
    const defOpen = scalar(`SELECT COUNT(*) AS v FROM deficiencies WHERE office=@office AND ${OPEN_DEF}`, shortLabel(office));
    const defUsd = defOpen * AVG_REPAIR_USD; // projected (deficiencies carry no price)
    return {
      office,
      label: shortLabel(office),
      jobs,
      won,
      lost,
      decided,
      winRate: decided > 0 ? Math.round((won / decided) * 100) : null,
      pipelineUsd: Math.round(pipelineCents / 100),
      plans,
      deficiencyOpen: defOpen,
      deficiencyUsd: Math.round(defUsd),
      onCallNow: onCallNow.has(shortLabel(office)),
    };
  });

  // rank by open pipeline (the money in play) by default
  rows.sort((a, b) => b.pipelineUsd - a.pipelineUsd);

  const totals = {
    offices: rows.length,
    jobs: rows.reduce((s, r) => s + r.jobs, 0),
    pipelineUsd: rows.reduce((s, r) => s + r.pipelineUsd, 0),
    deficiencyOpen: rows.reduce((s, r) => s + r.deficiencyOpen, 0),
    deficiencyUsd: rows.reduce((s, r) => s + r.deficiencyUsd, 0),
    plans: rows.reduce((s, r) => s + r.plans, 0),
  };

  res.json({ rows, totals });
});

export default router;
