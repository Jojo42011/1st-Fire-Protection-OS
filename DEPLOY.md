# Deploying 1st FP OS to Fly.io (SQLite on a volume)

The whole app is one container with its "brain" in a single SQLite file on a Fly
**volume**. That means **exactly one machine** — a volume attaches to one machine and
SQLite can't be shared across machines. Never `fly scale count 2`.

Data in `/data/1stfp.db` survives deploys, restarts, and machine moves.

---

## Option A — Deploy from your machine (fastest, recommended for the first deploy)

You run these locally; your Fly token never leaves your machine.

### 1. Install flyctl + log in
```bash
# macOS
brew install flyctl
# Linux / WSL
curl -L https://fly.io/install.sh | sh

fly auth login
```

### 2. Create the app (names are globally unique)
Pick a unique name and keep it in sync with `fly.toml` (the `app = ` line).
```bash
cd 1st-Fire-Protection-OS
APP=first-fp-os-<yourname>          # <-- choose a unique name
fly apps create "$APP"
sed -i '' "s/^app = .*/app = \"$APP\"/" fly.toml   # macOS (use sed -i on Linux)
```
Already have an app? Skip `apps create` and just set `app = "<your-app>"` in `fly.toml`.

### 3. First deploy (auto-creates the volume from `initial_size` in fly.toml)
```bash
fly deploy --remote-only --ha=false
```
`--ha=false` guarantees a single machine. The `[mounts] initial_size = "1gb"` line
makes Fly create the `fp_data` volume automatically on this first deploy.

> Prefer to create the volume explicitly? Do it before deploying:
> `fly volumes create fp_data --region dfw --size 1`

### 4. Open it
```bash
fly open           # -> https://<APP>.fly.dev
fly logs           # watch it boot + seed
```

That's it. It boots on seeded sample data with **zero secrets** (graceful
degradation). Add keys when you're ready — see step 6.

---

## Option B — Auto-deploy from GitHub (ongoing)

The repo already has `.github/workflows/deploy.yml`. It build-checks + boot-smoke-tests
every push, and deploys when a Fly token is present.

1. Create a deploy token:
   ```bash
   fly tokens create deploy -x 999999h
   ```
2. In GitHub: **repo → Settings → Secrets and variables → Actions → New repository
   secret** → name `FLY_API_TOKEN`, paste the token. (It's encrypted; it never appears
   in logs.)
3. The app + volume must exist first — do Option A steps 2–3 once. After that, every
   push to `main`/`master` (or the **Run workflow** button) deploys with `--ha=false`.

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

## Operating notes
- **One machine only.** SQLite + one volume. Don't scale out. To resize the box:
  `fly scale vm shared-cpu-1x --memory 1024`.
- **Backups.** Snapshot the volume: `fly volumes snapshots list <vol-id>` (Fly auto-snapshots
  daily). To pull the db down: `fly ssh console -C "cat /data/1stfp.db" > backup.db` (or use
  `fly sftp get /data/1stfp.db`).
- **Always-on vs scale-to-zero.** `fly.toml` sets `min_machines_running = 1` (receptionist
  always answers, reflection cron runs). Set it to `0` to scale to zero and save money — the
  machine cold-starts on the next request (~1–2s) but the 30-min reflection cron won't fire
  while stopped.
- **Reset the demo data.** `fly ssh console -C "rm /data/1stfp.db"` then `fly apps restart <APP>`
  — it re-seeds on boot.
