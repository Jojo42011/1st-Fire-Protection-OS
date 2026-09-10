# 1st Fire Protection OS - Production Runbook

Operational procedures for the live deployment. Keep this honest: where something is not
configured or not verified, it says so.

## Architecture (as deployed today)

- **App**: `first-fp-os` on Fly.io, region `dfw` (Dallas). One machine
  (`min_machines_running = 1`, shared-cpu-1x / 512mb). Single-process Express server.
- **Data**: one encrypted Fly volume `fp_data` mounted at `/data`, `DB_PATH=/data/1stfp.db`.
  SQLite (better-sqlite3) in WAL mode. Because it is one machine + one volume, there is no
  replica and no automatic failover.
- **Deploy**: GitHub Action runs `flyctl deploy` on every push to `main`. Health check is
  `GET /api/health`.
- **Backups**: Fly daily volume snapshots with LIMITED retention (about 5 days). This is NOT
  a complete recovery plan on its own (see Backups below).
- **Mode**: `DEMO_MODE=off` in production (live integrations). `OS_AUTH_MODE=hybrid`.

## Systems of record (source-of-truth boundaries)

- **ServiceTrade** - field-service operational entities (jobs, deficiencies, invoices source).
  The OS mirrors these read-only; it makes no direct ServiceTrade writes.
- **Sage Intacct** - authoritative A/R when connected (not integrated in this release).
- **BambooHR** - employee roster.
- **Microsoft Entra / Graph** - identity and selected access/licensing data; outbound mail.
- **OS-native** - drafts, approvals, tasks, audit history, estimating quotes, the project
  board, inspections, and operational overlays. These are the OS's own records, not a mirror.

## Access

- Sign-in: shared `APP_PASSWORD` gate (outer) plus Microsoft Entra sign-in mapped to app
  roles in Access & Roles. In `hybrid`/`enforce`, sensitive actions require the mapped identity.
- Admin endpoints require identity + Access:2 + the `ADMIN_TOKEN` secret.
- Rotate the shared password: `flyctl secrets set APP_PASSWORD=<new>`. This invalidates all
  existing shared sessions (the session key is derived from the password).

### Break-glass god mode (optional)

- Set `GOD_MODE_PASSWORD` (a Fly secret, minimum 12 characters) to enable a break-glass
  sign-in: entering it on the normal sign-in screen grants a full super-admin session (all
  offices, all modules) without Microsoft sign-in. Use it only as a fallback when identity
  access is broken or not yet set up, not for daily work.
- Every god-mode sign-in is written to the immutable audit trail (`auth.god_login`), and the
  Readiness screen flags it as a standing bypass whenever the secret is set.
- The session is short-lived (12 hours) and does NOT bypass the separate `ADMIN_TOKEN` gate on
  the raw database export/reset endpoints.
- Set it: `flyctl secrets set GOD_MODE_PASSWORD=<strong-random>`. Turn it off:
  `flyctl secrets unset GOD_MODE_PASSWORD`. Rotating it invalidates any active god session.
- It is stripped in demo mode, so it only ever works on the live deploy.

## Backups

**What exists:** Fly volume snapshots (daily, ~5-day retention), and an on-demand consistent
snapshot download at `GET /api/admin/backup` (SQLite online backup API, folds WAL). The
download requires identity + Access:2 + `ADMIN_TOKEN`, and fails closed if `ADMIN_TOKEN` is unset.

**What is NOT verified:** off-Fly retention. Do not treat a Fly snapshot as a verified backup.
The Readiness screen shows off-Fly backup as `not_configured` until you set one up.

**On-demand encrypted snapshot (manual):**
```
curl -fL -H "x-admin-token: $ADMIN_TOKEN" https://<app>/api/admin/backup -o 1stfp-os-backup.db
```
Store it encrypted off-machine (do not leave it in a shared or public location).

**Optional off-Fly export (disabled by default):** set `BACKUP_UPLOAD_URL` (a presigned PUT
URL) and `BACKUP_ENCRYPTION_KEY`, then trigger:
```
curl -fL -X POST -H "x-admin-token: $ADMIN_TOKEN" https://<app>/api/admin/backup/offsite
```
The DB is AES-256-GCM encrypted before upload; the upload is verified (2xx) before success is
recorded. Nothing is uploaded unless both variables are set.

## Restore drill (run against an ISOLATED target, never production first)

1. Provision a throwaway Fly app or run locally with a temp `DB_PATH`.
2. Obtain a backup file (admin backup download, a Fly snapshot volume, or a decrypted off-Fly
   export - decrypt with the same `BACKUP_ENCRYPTION_KEY`).
3. Point the isolated app at the restored file: `DB_PATH=/path/to/restored.db`.
4. Boot with `DEMO_MODE=off`. Confirm `GET /api/health` is ok and `GET /api/readiness`
   (as an admin) shows expected data and DB integrity `ok`.
5. Spot-check a few records (a recent quote, an approval, an audit row).
6. Only after a clean drill, plan the production restore in a maintenance window.

## Production restore (last resort)

1. Stop or scale down the machine to avoid writes during restore.
2. Replace `/data/1stfp.db` (and remove stale `-wal`/`-shm`) with the restored file.
3. Start the machine; verify health and readiness.
4. Never restore directly over live data without a current backup of the current state first.

## Incident response

1. Check `GET /api/health` and the Readiness screen for warnings.
2. Review recent logs (`flyctl logs`). The OS audit trail (`os_audit`) and readiness surface
   failed external actions and stale sources.
3. If a bad deploy: roll back (below). If data corruption: run the restore drill, then restore.
4. If a secret leaked: rotate it immediately (below) and review `os_audit` for misuse.

## Rollback

- Redeploy a known-good commit: revert on `main` (a GitHub Action redeploys), or
  `flyctl deploy` from the good ref. Schema changes are additive and idempotent, so rolling
  back code does not require a data migration.

## Secret rotation

- Rotate via `flyctl secrets set KEY=value` (triggers a restart). Never print or commit values.
- Priorities: `APP_PASSWORD`, `ADMIN_TOKEN`, `VAPI_SERVER_SECRET`,
  `SERVICETRADE_WEBHOOK_SECRET`, `MS_GRAPH_CLIENT_SECRET`, `ENTRA_CLIENT_SECRET`,
  `BACKUP_ENCRYPTION_KEY`.
- After rotating a webhook secret, update the provider (Vapi Server URL secret, ServiceTrade
  webhook token) to match, or live webhooks will be rejected.

## Offboarding: where each step runs

An offboarding is split across three planes, so the right tool runs each step and no PowerShell
modules have to coexist in one terminal:

- **On-prem AD (domain controller):** disable the account, reset the password, remove group
  membership, delete at retention. These are mastered on-prem and run through the DC agent
  ("Run on DC" on the board). Enabling/disabling a synced account is authoritative here.
- **Cloud, server-side via Microsoft Graph ("Run in cloud" on the board):** block sign-in +
  revoke sessions, remove the Microsoft 365 license, set the mailbox auto-reply, forward new mail
  to the manager, and grant the manager the departing user's OneDrive (the SharePoint delegation).
  These run from the OS with the app registration's own permissions: no `Connect-MgGraph`,
  `Connect-ExchangeOnline`, or `Connect-SPOService` on anyone's laptop. Every run is audited
  (`offboarding.cloud_run`).
- **Exchange Online only:** converting the mailbox to a shared mailbox has no Graph API, so it
  stays a small Exchange step (the "cloud script" on the request still covers it).
- **Shared-mailbox notifications:** some HR/Accounting tasks carry a "Email ..." button that sends a
  handoff from `offboarding@1stfpservices.com` to the right shared mailbox (Safety notify and
  Vehicle licensing to `safety@`, Sage removal and the accounting tasks to `accounting@`). Sending
  uses the existing `Mail.Send` grant; the `offboarding@` mailbox must exist. ServiceTrade removal is
  owned by IT; Bamboo and Employee Navigator stay with HR (manual).
- **No-directory people:** when a departing person has no AD account and no email (no UPN / SAM /
  object id), the OS auto-marks the account/mailbox/cloud steps N/A, so only the physical and
  other-system tasks remain. Physical-access steps (deactivate + collect key fobs, collect ID badge)
  are IT tasks that always apply.

### Graph application permissions for server-side cloud offboarding

Grant these to the same app registration (MS_GRAPH_CLIENT_ID) with admin consent. Each maps to
one step and fails closed with a clear "add this permission" message if missing:

| Step | Application permission |
| --- | --- |
| Block sign-in + revoke sessions | `User.ReadWrite.All` |
| Remove 365 license | `User.ReadWrite.All`, `Organization.Read.All` |
| Auto-reply | `MailboxSettings.ReadWrite` |
| Forward to manager | `Mail.ReadWrite` |
| OneDrive / SharePoint delegation | `Files.ReadWrite.All` |

## Readiness checklist (Company -> Readiness)

Green when: live mode on, `OS_AUTH_MODE=hybrid` or `enforce`, Entra configured, `ADMIN_TOKEN`
set, Vapi + ServiceTrade webhook secrets set, sources fresh, no failed external actions, and
a recent backup recorded. Anything unsafe is listed under Warnings.
