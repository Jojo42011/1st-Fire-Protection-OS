# Deploying 1st FP OS to Fly.io (SQLite on a volume)

The whole app is one container with its "brain" in a single SQLite file on a Fly
**volume**. That means **exactly one machine** — a volume attaches to one machine and
SQLite can't be shared across machines. Never `fly scale count 2`.

Data in `/data/1stfp.db` survives deploys, restarts, and machine moves.

---

## Option A — Auto-deploy from GitHub (RECOMMENDED — no local machine needed)

Everything runs in the cloud: GitHub's runner builds + deploys to Fly on every push.
The workflow (`.github/workflows/deploy.yml`) **bootstraps the app + volume on its first
run**, so you never touch a terminal. You only do two things once, both in a browser:

### 1. Create a Fly.io account + API token (browser)
- Sign up / log in at <https://fly.io> (a payment card is required even on the free
  allowances).
- Go to the Fly dashboard → **Tokens** (org-level) → **Create token** (or Account →
  Access Tokens). Copy it. This token can create apps and deploy.

> **Token scope matters — use an org/account token, not an app-scoped one.**
> `fly deploy` builds on a **remote builder machine** (`--remote-only`). If no
> `fly-builder-*` machine exists in the org yet — which is always true on the first
> deploy — flyctl has to **create** one, and that needs **org-level** permission. An
> **app-scoped** deploy token (`fly tokens create deploy -a <app>`) can deploy but
> **cannot provision the builder**, so a first deploy with it fails with:
> ```
> WARN Failed to start remote builder heartbeat: unauthorized
> Error: failed to fetch an image or build from source: unauthorized
> ```
> Fix: use an **org token** (`fly tokens create org -o <org-slug>`, or the dashboard
> Account → Access Tokens) for the initial deploy. Once a builder exists in the org, a
> narrower app-scoped token is enough for subsequent deploys.

### 2. Add the token as a GitHub repo secret (browser)
- In this repo on GitHub: **Settings → Secrets and variables → Actions →
  New repository secret**.
- Name: `FLY_API_TOKEN` — Value: paste the token. Save. (It's encrypted; it never
  appears in logs.)
- *(Optional)* If your Fly org isn't the default `personal`, add a repo **variable**
  `FLY_ORG` with your org slug.

### 3. Trigger a deploy
- Push any change (or GitHub → **Actions** tab → *Deploy to Fly.io* → **Run workflow**).
- First run: creates the app `first-fp-os` (rename in `fly.toml` if that's taken — edit
  the `app = ` line right in GitHub's web editor), auto-creates the `fp_data` volume,
  deploys one machine. Every later push just deploys an update.
- URL: `https://<app-name>.fly.dev`. Watch progress in the **Actions** tab.

That's the whole thing. Data in `/data/1stfp.db` (facts, calls, reviews, memory) persists
across every deploy. Add API keys later as Fly secrets — see the bottom section.

---

## Option B — Deploy from your own machine (only if you prefer the CLI)

### 1. Install flyctl + log in
```bash
brew install flyctl                 # macOS   (Linux/WSL: curl -L https://fly.io/install.sh | sh)
fly auth login
```
### 2. Create the app + deploy
```bash
cd 1st-Fire-Protection-OS
APP=first-fp-os-<yourname>          # must be globally unique + start with a letter
perl -pi -e "s/^app = .*/app = \"$APP\"/" fly.toml
fly apps create "$APP"
fly deploy --remote-only --ha=false # --ha=false = one machine; volume auto-creates
fly open
```

---

## 5. Confirm it's healthy
```bash
curl https://<APP>.fly.dev/api/health
# {"ok":true,"brain":"none","telephony":false,...}  ← "none" = no LLM key yet, still fine
fly status         # should show ONE machine, attached to volume fp_data
fly volumes list   # fp_data, 1GB, region dfw
```

## 6. Go live later — set secrets (no redeploy of code needed)
Each feature no-ops without its key; add keys to light them up.
```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-...        # or OPENAI_API_KEY — enables conversation + drafting
fly secrets set OPENAI_API_KEY=sk-...               # also enables embeddings (memory recall)
fly secrets set VAPI_API_KEY=... ELEVENLABS_API_KEY=...   # Call Receptionist goes live
fly secrets set SERVICETRADE_TOKEN=...              # Invoice Collector pulls real receivables
fly secrets set GOOGLE_BUSINESS_TOKEN=... FACEBOOK_PAGE_TOKEN=...   # Review Collector
```
`fly secrets set` restarts the machine automatically. See `.env.example` for the full list.

---

## Troubleshooting deploys

- **`WARN Failed to start remote builder heartbeat: unauthorized`** (then
  `failed to fetch an image or build from source: unauthorized`). The token is valid but
  **too narrow to provision the remote builder**. Use an **org/account token** for the
  first deploy (see the token-scope note in Option A §1). App-scoped tokens only work once
  a `fly-builder-*` machine already exists in the org.

- **`verify: root banned: <token-id>`** (or `no verified tokens`). Fly has banned that
  token's **root** — an **account/org-level** ban (a suspended account), not a per-token
  revocation. Two things to know:
  - **The ban survives an account restore.** If support un-suspends the account, tokens
    that were already banned **stay** banned — lifting the ban only helps tokens **minted
    afterward**. Always create a **fresh** token after an unban; don't reuse the old one.
  - **It can hide behind a stale env var.** If `FLY_API_TOKEN` is exported in the shell
    (CI, a container, a dev box), flyctl uses it even when you pass `-t`/`--access-token`,
    and a banned value there poisons the whole request. Run with the env cleared:
    `env -u FLY_API_TOKEN fly deploy … -t "<good-token>"`.

- **Building behind a TLS-intercepting proxy** (`x509: certificate signed by unknown
  authority` from the depot builder). Add `--depot=false` to fall back to the legacy
  remote builder, which uses a trusted HTTPS path:
  `fly deploy --remote-only --depot=false --ha=false`.

- **GitHub Actions deploy fails in ~3s with no runner assigned.** That's a **GitHub
  billing/spending block on the repo owner's account**, not a Fly problem — the deploy job
  never runs because `needs: build` fails first. Fix GitHub billing, or deploy directly
  with flyctl (Option B) to bypass Actions entirely.

---

## Operating notes
- **One machine only.** SQLite + one volume. Don't scale out. To resize the box:
  `fly scale vm shared-cpu-1x --memory 1024`.
- **Backups.** Easiest — download a consistent snapshot over HTTP, no SSH:
  `curl -fL "https://<APP>.fly.dev/api/admin/backup" -o 1stfp-backup.db` (uses SQLite's online
  backup API, so it folds in the WAL and is never torn). Or snapshot the volume:
  `fly volumes snapshots list <vol-id>` (Fly auto-snapshots daily), or pull the raw file with
  `fly ssh console -C "cat /data/1stfp.db" > backup.db` / `fly sftp get /data/1stfp.db`.
- **Always-on vs scale-to-zero.** `fly.toml` sets `min_machines_running = 1` (receptionist
  always answers, reflection cron runs). Set it to `0` to scale to zero and save money — the
  machine cold-starts on the next request (~1–2s) but the 30-min reflection cron won't fire
  while stopped.
- **Reset the demo data.** Three ways, no file surgery needed:
  - **HTTP (no restart):** `curl -X POST https://<APP>.fly.dev/api/admin/reset-demo -H 'content-type: application/json' -d '{"confirm":"reset"}'`
    — wipes every table and re-seeds the sample dataset in place. Refuses if ServiceTrade
    is connected (looks like real data); set `ALLOW_DEMO_RESET=1` to override.
  - **CLI:** `fly ssh console -C "cd /app && npm run reset"` — same wipe + re-seed.
  - **Nuke the file (old way):** `fly ssh console -C "rm /data/1stfp.db"` then
    `fly apps restart <APP>` — it re-seeds on boot.
- **Lock down admin endpoints.** `/api/admin/*` (reset + backup) are open by default for the
  demo. Set a Fly secret `fly secrets set ADMIN_TOKEN=<value>` to require it — pass it as
  `?token=<value>` or an `x-admin-token` header on every admin call.
