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
