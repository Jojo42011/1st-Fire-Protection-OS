# Production Hardening and Trust Layer

This release makes 1st Fire Protection OS safe for daily, multi-office use on live data
without changing the architecture (Express, static HTML, better-sqlite3, single Fly
machine, Signal UI, draft-first approval philosophy).

## What changed

**1. Legacy Northstar identity removed from production surfaces**
- Boot banner now prints `1st Fire Protection OS [LIVE|DEMO]` with the auth mode.
- The founder layer (`server/src/config/constants.ts`) now identifies 1st Fire
  Protection Services, LLC (name, legal, San Antonio HQ, phone, site, receptionist
  greeting, real office locations).
- Partner cross-sell badge and export strings, and the brand-kit README, rebranded.
- The downloaded backup file is named `1stfp-os-backup-<stamp>.db`.
- The live SQLite path (`northstardemo.db` default) is intentionally NOT changed:
  production sets `DB_PATH=/data/1stfp.db` via `fly.toml`, and renaming the default
  would orphan a live database. Legacy office-name strippers are behavioral and left in place.

**2. A real OS authorization boundary (`server/src/os/authz.ts`, `os/policy.ts`)**
- New `OS_AUTH_MODE` with three postures: `legacy`, `hybrid` (default), `enforce`.
- Reusable middleware `requireOs(policy)` plus a pure, unit-tested `decide()` function.
- Office scope is always resolved against the caller (`officeKeysOrFail`,
  `writeOfficeOrFail`, `pricingOfficeOrFail`, `canActOnOffice`) - the raw client
  `office` is never trusted as authority.
- A central policy registry (`os/policy.ts`) documents which module + level + sensitivity
  protects each route, visible on the readiness screen.
- Clear `401 identity_required`, `403 forbidden`, `403 office_forbidden` responses.
- Every sensitive write stamps the authenticated actor (`actorOf`), never a hardcoded
  or client-supplied label. Added a visible `pricing` module for price book / margin edits.

**3. Estimating and proposal lockdown (`routes/estimatingBuilder.ts`, `services/quotesBuilder.ts`)**
- Every `/api/estimating/*` route is authorized and office-scoped; quote and line IDs
  are checked against the caller's office so they cannot cross offices.
- Search endpoints (accounts, deficiencies, quotes, price book) return only in-scope rows.
- Price book and margin edits require the `pricing` module (level 2).
- Immutable audit entries (`os_audit`) for create/edit/status/delete/duplicate/takeoff,
  price and margin changes, and sends: actor, office, subject, old/new summary, timestamp.
- Validation for negative/malformed values, invalid status, invalid email.
- Quotes are soft-deleted (`deleted_at`), auditable and reversible.
- Auto-takeoff carries a visible "estimator assistant, not a design" disclaimer in the
  builder and on the emailed proposal.

**4. Approval-controlled, idempotent external sends (`services/outbox.ts`)**
- A new `external_actions` outbox ledger. A proposal never sends from a browser click:
  sending queues an approval bound to a revision hash of the exact quote + recipient.
- Editing the quote changes the hash and supersedes the prior approval; execution
  re-checks the revision and refuses a changed one.
- Execution is server-side and idempotent (`idempotency_key` UNIQUE + status re-check),
  so retries, refreshes, double-clicks, or a restart never send twice.
- Records attempted/sent/failed/superseded with SAFE provider metadata only (no tokens
  or response bodies). Approvals now stamp the real approver, not "Devon".

**5. Admin + webhook hardening (`routes/admin.ts`, `callWebhook.ts`, `servicetradeWebhook.ts`, `os/security.ts`)**
- `/api/admin/backup` and `/api/admin/reset-demo` require identity + Access:2 + the admin
  secret, and FAIL CLOSED in production when `ADMIN_TOKEN` is unset (503, not an open download).
- Vapi webhook rejects unauthenticated requests in live mode; ServiceTrade webhook uses a
  timing-safe compare and requires its secret in live mode.
- Security headers, a same-origin CSRF guard for cookie-authenticated state changes
  (webhooks/agent/intake/login exempt), and a small in-memory rate limiter on login and
  the public webhook/intake routes. No new dependencies.

**6. Production readiness (`services/readiness.ts`, `routes/readiness.ts`, `client/readiness.html`)**
- Admin-only `GET /api/readiness` returns a safe posture snapshot (no secrets, PII, tokens,
  or DB paths): auth posture, admin/webhook protection, integration state, per-source
  freshness, backups, pending approvals, failed actions, DB integrity, and explicit warnings.
- High-severity warnings are also logged once at boot in live mode.

**7. Backup and recovery posture (`docs/PRODUCTION_RUNBOOK.md`, `services/backupExport.ts`)**
- A runbook documenting the real architecture and backup/restore/incident/rollback/
  secret-rotation procedures, plus a restore-drill checklist.
- Optional encrypted off-Fly backup export, DISABLED by default, enabled only when
  `BACKUP_UPLOAD_URL` + `BACKUP_ENCRYPTION_KEY` are set. AES-256-GCM, verifies upload,
  never logs secrets. Triggerable at `/api/admin/backup/offsite`.

**8. Data truth and source labels**
- OS-native screens (Job Board, Inspections) are labeled as OS-native overlays, not
  ServiceTrade records. Readiness makes stale sources obvious. No Sage Intacct work in
  this release; no direct ServiceTrade writes.

## New environment variables and safe defaults

| Variable | Default | Purpose |
|---|---|---|
| `OS_AUTH_MODE` | `hybrid` | `legacy` \| `hybrid` \| `enforce` authorization posture |
| `ADMIN_TOKEN` | unset -> admin endpoints fail closed in prod | Secret for `/api/admin/*` |
| `BACKUP_UPLOAD_URL` | unset -> off-Fly backup disabled | Presigned PUT destination |
| `BACKUP_ENCRYPTION_KEY` | unset -> off-Fly backup disabled | AES-256-GCM passphrase |

Existing, still honored: `APP_PASSWORD`, `OS_REQUIRE_IDENTITY`, `VAPI_SERVER_SECRET`,
`SERVICETRADE_WEBHOOK_SECRET`, `ENTRA_*`, `MS_GRAPH_*`, `MS_MAIL_FROM`, `DEMO_MODE`,
`PUBLIC_BASE_URL`, `PEOPLE_BOOTSTRAP_EMAIL`.

## Migration / rollout order

1. Deploy this release. Schema changes are idempotent (`initDb` on boot); no data migration.
   `OS_AUTH_MODE` defaults to `hybrid`, so no one is locked out: shared-password reads keep
   working, but sensitive writes now require a mapped Entra identity.
2. Set `ADMIN_TOKEN` (see below). Until it is set, admin backup/reset fail closed in prod.
3. Confirm `ENTRA_*` is configured and map each operator in Access & Roles, granting office
   scope and the right roles (partner/branch_manager for estimating, partner/accounting for
   pricing, people_admin for admin).
4. Open the Readiness screen (Company -> Readiness) and clear warnings.

## Fly secrets Devon must set himself

Set these with `flyctl secrets set` (this release does not and cannot set them):

- `ADMIN_TOKEN=<a long random string>` - required to enable admin backup/reset in production.
- `OS_AUTH_MODE=hybrid` - optional now (hybrid is the default); set explicitly to make it visible.
- Optional off-Fly backups: `BACKUP_UPLOAD_URL=<presigned PUT URL>` and
  `BACKUP_ENCRYPTION_KEY=<passphrase>`.

Do NOT commit any secret value. Verify others are already set: `APP_PASSWORD`,
`VAPI_SERVER_SECRET`, `SERVICETRADE_WEBHOOK_SECRET`, `ENTRA_*`, `MS_GRAPH_*`, `MS_MAIL_FROM`.

## Moving legacy -> hybrid -> enforce

- `legacy`: shared-password everywhere; readiness warns loudly. Use only as a temporary
  fallback if hybrid causes a problem.
- `hybrid` (default): shared-password reads still work; sends, writes, deletes, pricing, and
  admin require a mapped identity + role + office scope. Stay here until every operator is
  mapped in Access & Roles.
- `enforce`: set `OS_AUTH_MODE=enforce` once all operators are mapped. Every protected page
  and API then requires a mapped Entra identity. Keep `APP_PASSWORD` only if you still want
  the outer gate; otherwise it can be retired.

## Deliberate follow-up work

- Extend `requireOs` coverage to the remaining older route files (People already has its own
  stricter `requirePeople`; receivables/service/reports still lean on page-level gating).
- Wire a scheduled off-Fly backup tick (currently admin-triggered) once a destination is set.
- Retire `APP_PASSWORD` after moving to `enforce`.
- Sage Intacct A/R integration remains out of scope until a tested connector exists.
