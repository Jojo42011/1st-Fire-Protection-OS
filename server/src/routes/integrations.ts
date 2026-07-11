import { Router } from 'express';
import { resolveIntegrations } from '../config/integrations';
import { AGENTS } from '../config/agents';

const router = Router();

router.get('/api/integrations', (_req, res) => {
  const integrations = resolveIntegrations();
  // group by category for the catalog view
  const byCategory: Record<string, typeof integrations> = {};
  for (const i of integrations) {
    (byCategory[i.category] ||= []).push(i);
  }
  res.json({
    integrations,
    byCategory,
    team: AGENTS.map((a) => ({
      key: a.key,
      name: a.name,
      role: a.role,
      status: a.status,
      connectVia: a.connectVia || [],
    })),
    counts: {
      connected: integrations.filter((i) => i.status === 'connected').length,
      available: integrations.filter((i) => i.status === 'available').length,
      planned: integrations.filter((i) => i.status === 'planned').length,
    },
  });
});

export default router;
