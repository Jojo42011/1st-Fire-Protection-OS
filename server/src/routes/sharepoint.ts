import { Router } from 'express';
import { requirePeople } from '../people/authz';
import { auditSharedSite, sharepointConfigured } from '../services/msGraphSharePoint';

/**
 * SharePoint access audit, in the OS instead of PowerShell. Gated to IT / People admins, since it
 * reveals who can reach the company's SharePoint content. Reads only (Sites.Read.All).
 */
const router = Router();

// The site we audit by default. Overridable per request (?url=) so any site can be checked.
const DEFAULT_SITE = process.env.SHAREPOINT_AUDIT_URL || 'https://1stfp.sharepoint.com/sites/Shared';

/** Whether the audit can run (Graph connected), and the default site, for the UI to render state. */
router.get('/api/sharepoint/status', requirePeople('people_admin', 'it'), (_req, res) => {
  res.json({ ok: true, graphConfigured: sharepointConfigured(), defaultSite: DEFAULT_SITE });
});

/** Run the audit for a site and return who can access it and each of its top-level folders. */
router.get('/api/sharepoint/audit', requirePeople('people_admin', 'it'), async (req, res) => {
  const url = String(req.query.url || DEFAULT_SITE);
  const out = await auditSharedSite(url);
  res.json(out);
});

export default router;
