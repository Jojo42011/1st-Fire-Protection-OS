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

## Readiness checklist (Company -> Readiness)

Green when: live mode on, `OS_AUTH_MODE=hybrid` or `enforce`, Entra configured, `ADMIN_TOKEN`
set, Vapi + ServiceTrade webhook secrets set, sources fresh, no failed external actions, and
a recent backup recorded. Anything unsafe is listed under Warnings.
