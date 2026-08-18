import { Router } from 'express';
import { currentContext, allowedOffices } from '../os/scope';
import { currentIdentity } from '../people/identity';

/**
 * GET /api/me — the OS-wide "who am I and what can I see" endpoint that the shell boots from.
 *
 * Returns the caller's roles, the offices they are authorized for (canonical key + label), whether
 * they have company-wide scope, and a sensible default office for the global selector. The server
 * is always the authority: this endpoint only *describes* scope — every data endpoint independently
 * enforces it. Legacy shared-password sessions report legacy:true with company-wide access until the
 * migration to per-user identity completes.
 */
const router = Router();

router.get('/api/me', (req, res) => {
  const ctx = currentContext(req);
  const offices = allowedOffices(ctx);
  const identity = currentIdentity(req);

  // Default office for the selector: company-wide -> "all"; single office -> that office;
  // multi-office scoped -> the caller's own offices (represented as "__scoped__").
  let defaultOffice = 'all';
  if (!ctx.allOffices) defaultOffice = offices.length === 1 ? offices[0].key : '__scoped__';

  res.json({
    ok: true,
    legacy: ctx.legacy,
    identity: identity ? { email: identity.email, name: identity.name || null } : null,
    email: ctx.email,
    roles: ctx.roles,
    offices,
    canSeeAllOffices: ctx.allOffices,
    defaultOffice,
    // People uses its own Entra-gated authorization; the shell just needs to know whether to show it.
    peopleAuthorized: !!ctx.user && ctx.user.roles.length > 0,
  });
});

export default router;
