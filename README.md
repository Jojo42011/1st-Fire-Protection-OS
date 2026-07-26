# 1st Fire Protection — Operating System

An **AI operating system** for **1st Fire Protection Services, LLC** — the single-source life
safety provider for Central & South Texas (San Antonio HQ, 9 locations, $40M+ built on word of
mouth). Not one chatbot — a set of named AI "employees" that share **one** Express +
better-sqlite3 backend and **one** SQLite "brain," presented behind a collapsible tabbed shell.

> **SINGLE-SOURCE LIFE SAFETY** — 108 years of combined experience · SCTRCA · MBE · SBE · HUB.

**Brand — "Signal":** light-first and calm, shaped like modern SaaS rather than a control
room. Off-blue-white surfaces `#F7F8FB`, white cards, near-black ink `#151A2D`. Colour is
*meaning* — green `#2FA36B` = phones, pink-red `#E02D62` = money, amber `#E2A93C` =
reputation, indigo `#4C5BD4` = system / AI / spend. The brand heat survives as the `1F`
logo gradient (`#FF6B4A → #E02D62`) and the pink-red money accent. **Figtree** for
everything, **Geist Mono** for numeric/technical micro-text. The design system lives in
`client/signal.css`; fonts are self-hosted in `client/brand/` and loaded via
`client/brand/brand.css`. (The earlier fire-red-on-navy "command room" system is retired;
`command.css` remains only for pages not yet migrated.)

## The four employees

| Agent | Tab | Status | Job |
|---|---|---|---|
| **Call Receptionist** | `calls` (home) | connecting soon | Answers the San Antonio line (210-377-FIRE) 24/7, classifies the call, and routes it into Teams — inspections, sprinkler/alarm service, extinguishers, billing, sales, or a named person. Complaints → Daniel Rodriguez; Mario Salinas → voicemail; Spanish callers helped in Spanish; emergencies → after-hours queue. |
| **Invoice Collector** | `invoices` | standalone | Chases ServiceTrade receivables, drafts friendly→firm reminders, tracks aging. |
| **Review Collector** | `reviews` | standalone | Turns completed jobs into Google/Facebook reviews, drafts on-brand replies, tracks reputation. |
| **Audit** | `audit` | standalone | An enterprise operations consultant living in the OS. Home view is a radial wheel of the 9 REAL departments (from the live routing prompt: Inspections, Service & Repair, Sales & Estimating, Projects & Permits, Finance, HR, Operations, Vendors, Front Desk). Click one → split-screen consult: left asks one question at a time (comfort-rail chips + type/dictate), right shows that department's AI assembling — agents lighting up with build-week estimates as answers land. Under the hood each answer flows to the operator brain: it classifies the observation onto the 8 operational pillars, finds the leak (benchmark-cited: 30–50% deficiency conversion, 24h-quote 2–3× lever, 15–30 days DSO), matches it to a buildable AI capability that blooms on the pillar map, and hands back the next consultant question. Tracks all 9 locations, the veteran/SPOF map, and assembles the executive brief on demand. Full rules-engine fallback — the keyless demo still lands. |

Two are **standalone** — they demo on seeded sample data today. The **Call Receptionist** is
**built and one API key away from live**: it mirrors the real San Antonio routing brain
(`automation/vapi/system-prompt.md` in the ops repo), and the telephony webhook + LLM lead
extraction already exist and no-op until `VAPI_API_KEY` / `TWILIO_*` / `ELEVENLABS_API_KEY`
are present. Live path: forward 210-377-FIRE → Twilio → Vapi (BYO OpenAI key) → transfer into Teams.

## The two-layer philosophy

- **The hull** — a universal cognitive engine, identical for every client: memory
  (facts/episodes/graph/rules with hybrid retrieval), the brain agent-loop, the voice pipeline,
  the shell UI, the integration catalog, graceful degradation.
- **The founder layer** — a thin, per-company identity dropped on top. For 1st FP that's:
  - `server/src/config/constants.ts` — brand + personas + system prompts
  - `server/src/config/theme.ts` + the shell's `:root` CSS vars — the palette (Signal: light-first, colour-as-meaning)
  - `server/src/config/agents.ts` — which employees exist
  - `server/src/config/integrations.ts` — which hands are wired
  - the shell's `TABS` array

Swap the founder layer → new company, same hull.

## Non-negotiable conventions

- **Graceful degradation.** Missing key → log a line and no-op. Never crash. A keyless boot still
  runs the whole UI on seeded data. (`activeProvider()` returns `none` → the brain uses reasoned
  templates; embeddings fall back to keyword-only recall; TTS returns 204 → browser speech.)
- **Gated vs. free actions.** Reversible/in-house actions (draft, schedule, log, open a tab) run
  directly. Anything that leaves the building (send an email/SMS, publish a reply, quote a price,
  charge a card) is **gated** — the agent drafts it, a human clicks **Approve & Send**.
- **Standalone until connected.** Every dashboard renders with sample data and shows a
  "connect to go live" state — it never looks broken.
- **One schema source of truth.** All tables/migrations in `server/src/db/schema.ts` via an
  idempotent `initDb()`. Seed is guarded by a `system_state` flag.

## Run it

```bash
npm install
npm run build
DB_PATH=/tmp/1stfp.db PORT=3900 node server/dist/app.js
# open http://localhost:3900
```

Or the one-liner: `npm run boot-check`.

Click every tab: all three dashboards render on sample data, the receptionist chat/mic works
(say "show me the invoices" and it drives the shell via `postMessage`), collapse works
(Ctrl/⌘ + `\`), and Integrations shows the full capability catalog.

## Go live later (no code change)

| Add key(s) | Lights up |
|---|---|
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Full conversation + on-brand drafting + memory extraction, **and the Harness coder** (Claude/**Opus 4.8** by default writes each new agent's real code module; without any key, a template) |
| `MOONSHOT_API_KEY` + `CODER=kimi` | Opt in to **Kimi K3** as the coder instead of Opus (escalates to the **K3 swarm** on complex builds via `MOONSHOT_SWARM`). Off by default. |
| `OPENAI_API_KEY` | Embeddings → hybrid memory recall |
| `VAPI_API_KEY` / `TWILIO_*` + `ELEVENLABS_API_KEY` | Call Receptionist flips to **live** |
| `QUICKBOOKS_ACCESS_TOKEN` / `STRIPE_API_KEY` | Invoice Collector pulls real receivables |
| `GOOGLE_BUSINESS_TOKEN` | Review Collector pulls & publishes replies |
| `GMAIL_ACCESS_TOKEN` / `TWILIO_*` | Approved reminders & requests actually send |

See `.env.example` for the full list.

## Architecture

```
client/                     static UI (no build step)
  shell.html                THE SHELL — collapsible sidebar, tabbed iframes, postMessage nav
  calls.html                Receptionist (home) — voice/chat + call log + leads
  invoices.html             Invoice Collector dashboard
  reviews.html              Review Collector dashboard
  integrations.html         the capability catalog
  theme.css                 shared dashboard styling (themed off the palette)

server/src/
  app.ts                    Express + static + WS upgrade + reflection cron
  db/schema.ts              idempotent initDb() — ONE schema source of truth
  db/memory.ts              facts/episodes/graph/rules + hybrid retrieval
  brain/agentLoop.ts        LLM call + prompt assembly + tool loop + SSE streaming
  brain/tools.ts            open_tab, get_agent_status + per-agent draft/summary tools
  config/                   THE FOUNDER LAYER (constants, theme, models, voice, agents, integrations)
  services/                 invoiceAgent, reviewAgent, receptionist, embeddings, extraction,
                            reflection, tts, vision, llm
  routes/                   one route file per agent + brain, health, integrations, voice, callWebhook
  seed/                     idempotent sample data (invoices, jobs, reviews, calls, leads)
```

## Deploy

`Dockerfile` + `fly.toml` (Fly.io, Dallas region, persistent volume for the SQLite brain) +
GitHub Actions (`.github/workflows/deploy.yml`) that build-checks + boot-smoke-tests on every
push and deploys when `FLY_API_TOKEN` is set. A keyless deploy still boots.

---

*Built from the "AI Operating System — Reusable Build Kit." The founder layer is a swap; the hull
is reused.*
