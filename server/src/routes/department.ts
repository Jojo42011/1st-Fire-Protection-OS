import { Router } from 'express';
import { listAgents } from '../services/agentRuntime';
import { DEPARTMENTS } from '../config/departments';

const router = Router();

/**
 * ONE department dashboard feed. A department is a dashboard; the agents that serve it (founding +
 * harness-built) are its sub-dashboards. Returns the department identity, real headline KPIs
 * (agent counts and skills, no fabricated live numbers), and the roster filtered to this pillar.
 */
router.get('/api/department/:pillar', (req, res) => {
  const pillar = String(req.params.pillar || '');
  const dept = DEPARTMENTS.find((d) => d.key === pillar);
  const agents = listAgents().filter((a) => (a.pillar_key || '') === pillar);
  const built = agents.filter((a) => a.origin === 'harness').length;
  const skills = agents.reduce((n, a) => n + (a.skill_count || 0), 0);

  res.json({
    ok: true,
    pillar,
    name: dept?.name || (agents[0] && agents[0].pillar) || pillar,
    aiRole:
      dept?.aiRole ||
      'Every agent working this department, each running its own dashboard under one roof.',
    // Real, honest headline numbers. No invented live metrics.
    kpis: [
      { label: 'Agents live', value: agents.length, accent: false },
      { label: 'Built by the Harness', value: built, accent: true },
      { label: 'Skills across the team', value: skills, accent: false },
    ],
    agents,
  });
});

export default router;
