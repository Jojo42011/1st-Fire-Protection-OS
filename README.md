# 1st FP Operating System

An **AI operating system** for **1st FP Companies — 1st Fire Protection** (fire protection &
life safety, Texas). Not one chatbot — a set of named AI "employees" that share **one** Express +
better-sqlite3 backend and **one** SQLite "brain," presented behind a collapsible tabbed shell.

> **WE GO ANYWHERE** — committed to saving lives and property · 108 years of combined experience.

## The three employees

| Agent | Tab | Status | Job |
|---|---|---|---|
| **Call Receptionist** | `calls` (home) | connecting soon | Answers inbound calls 24/7, books inspections/service, captures leads, transfers emergencies. |
| **Invoice Collector** | `invoices` | standalone | Chases receivables, drafts polite→firm reminders, tracks aging. |
| **Review Collector** | `reviews` | standalone | Requests reviews from happy customers, drafts on-brand replies, tracks reputation. |

Two are **standalone** — they demo on seeded sample data today. The **Call Receptionist** is
**built and one API key away from live**: the telephony webhook + LLM lead extraction already
exist and no-op until `VAPI_API_KEY` / `ELEVENLABS_API_KEY` / `TWILIO_*` are present.

## The two-layer philosophy

- **The hull** — a universal cognitive engine, identical for every client: memory
  (facts/episodes/graph/rules with hybrid retrieval), the brain agent-loop, the voice pipeline,
  the shell UI, the integration catalog, graceful degradation.
- **The founder layer** — a thin, per-company identity dropped on top. For 1st FP that's:
  - `server/src/config/constants.ts` — brand + personas + system prompts
  - `server/src/config/theme.ts` + the shell's `:root` CSS vars — the palette (fire-red on navy)
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
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Full conversation + on-brand drafting + memory extraction |
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
