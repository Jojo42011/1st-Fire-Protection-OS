import { Policy } from './authz';

/**
 * The central authorization policy registry.
 *
 * Named policies (P) are applied by the route files via requireOs(P.xxx). The REGISTRY array is the
 * human-reviewable map of which module + level + sensitivity protects each protected route: when a new
 * sensitive route is added, add a line here so coverage is obvious in one place and on the readiness
 * screen. A hidden nav item is never authorization; these policies are the server-side control.
 */

export const P = {
  // Estimating / quotes (Access module: 'deficiencies')
  estimating_read: { module: 'deficiencies', level: 1, sensitive: false } as Policy,
  estimating_write: { module: 'deficiencies', level: 2, sensitive: true } as Policy,
  // Price book + margins are commercial policy: stricter 'pricing' module.
  pricing_read: { module: 'pricing', level: 1, sensitive: false } as Policy,
  pricing_write: { module: 'pricing', level: 2, sensitive: true } as Policy,
  // Sending a customer proposal is externally consequential: an editing-level identity, and it still
  // routes through approval + the outbox.
  proposal_send: { module: 'deficiencies', level: 2, sensitive: true } as Policy,
  // Jobs board (Access module: 'service')
  jobs_read: { module: 'service', level: 1, sensitive: false } as Policy,
  jobs_write: { module: 'service', level: 2, sensitive: true } as Policy,
  // Inspections (Access module: 'service')
  inspections_read: { module: 'service', level: 1, sensitive: false } as Policy,
  inspections_write: { module: 'service', level: 2, sensitive: true } as Policy,
  // Approvals inbox: viewing is overview; deciding is sensitive and needs a real identity.
  approvals_read: { module: 'overview', level: 1, sensitive: false } as Policy,
  approvals_decide: { module: 'overview', level: 1, sensitive: true } as Policy,
  // Admin surfaces (backup/reset) and readiness require the Access module; admin also needs the
  // dedicated admin secret / production-admin mode enforced in the route.
  admin: { module: 'access', level: 2, sensitive: true } as Policy,
  readiness: { module: 'access', level: 1, sensitive: false } as Policy,
};

export interface RegistryEntry { method: string; path: string; policy: keyof typeof P; note: string }

/** The reviewable coverage map. Keep in sync when adding a protected route. */
export const REGISTRY: RegistryEntry[] = [
  { method: 'GET', path: '/api/estimating/quotes*', policy: 'estimating_read', note: 'read quotes in office scope' },
  { method: 'POST/PUT/DELETE', path: '/api/estimating/quotes*', policy: 'estimating_write', note: 'create/edit/delete/duplicate/status/takeoff, office-scoped, audited' },
  { method: 'GET', path: '/api/estimating/pricebook,/margins', policy: 'pricing_read', note: 'read price book + margins' },
  { method: 'POST/PUT/DELETE', path: '/api/estimating/pricebook*,/margins', policy: 'pricing_write', note: 'edit price book + margins, audited' },
  { method: 'POST', path: '/api/estimating/quotes/:id/send', policy: 'proposal_send', note: 'approval + outbox, idempotent, audited' },
  { method: 'ALL', path: '/api/jobboard*', policy: 'jobs_write', note: 'writes need service:2; reads jobs_read' },
  { method: 'ALL', path: '/api/inspections*', policy: 'inspections_write', note: 'writes need service:2; reads inspections_read' },
  { method: 'GET', path: '/api/approvals', policy: 'approvals_read', note: 'view the inbox' },
  { method: 'POST', path: '/api/approvals/:id/*', policy: 'approvals_decide', note: 'approve/skip/edit need identity, real actor' },
  { method: 'GET/POST', path: '/api/admin/*', policy: 'admin', note: 'identity + Access:2 + admin secret; fails closed in production' },
  { method: 'GET', path: '/api/readiness', policy: 'readiness', note: 'admin-only posture, no secrets' },
];
