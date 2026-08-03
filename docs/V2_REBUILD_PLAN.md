# 1st Fire Protection OS — v2 Rebuild Plan

**From a fixture-backed demo to a connected operations platform on live ServiceTrade data.**

Status: in progress · Phases: 6 · Decisions: 5 (recommendations below)

A rendered version of this plan is also available as an artifact.

---

## 00 · Where we are today

The app just started running on live ServiceTrade data:

| Metric | Value |
| --- | --- |
| Customers (accounts) | **2,312** live from ServiceTrade |
| Sites | **6,130**, all linked to accounts |
| Invoices | **3,088** → 684 real account balances |
| At-risk accounts (overdue) | **177** |

It's a single Express server with a SQLite "brain" on one Fly machine, serving
build-step-free static screens (plain HTML + vanilla JS) styled by the **Signal** design
system. A ServiceTrade connector — OAuth2, a read-only/write safety toggle, a webhook
receiver, and a background pull path — is in place and read-only. Five agents (Estimator,
Closer, Dispatcher, Plan Manager, Job Costing) plus the founding four draft their work into
one approvals inbox.

It was built to **demo** on seeded data. With real data arriving, the seams show:

- **List screens don't scale.** Accounts shows a hard-coded slice of eight — of 2,312. No
  server-side search, filter, sort, or pagination. Sites (6,130) is worse.
- **Data is siloed per feature.** Each agent/screen grew its own tables and fixtures. There's
  no single spine every screen and agent reads from.
- **Sync is manual and all-or-nothing.** Pulls are full re-reads on a button press. Nothing
  keeps data fresh on its own, though the webhooks to do it exist.
- **Agents reason over fixtures, not reality.** Their logic is real; their inputs are seeded.

---

## 01 · Principles — what stays, what changes

**Stays (load-bearing):**
- Propose-then-approve: agents draft, humans approve gated actions.
- Read-only by default on every connector; writes are a deliberate toggle.
- Keyless boot: unconnected = a working demo, never a broken screen.
- The Signal design language and the approvals inbox.
- SQLite on one machine — still the right call at this scale.

**Changes (the rebuild):**
- One connected data spine every screen and agent reads.
- Server-side query for lists: search, filter, sort, paginate.
- Sync as a system: incremental, scheduled, webhook-driven.
- Agents operate on the real spine, not seed tables.
- A connector framework: ServiceTrade now, Sage Intacct next.

---

## 02 · The data spine

One canonical model of the business that everything else reads from. The CRM mirror tables
already carry the right bones — an external id, a `source`, a `sync_state`, updated
timestamps. v2 makes that **the** pattern: normalized entities, consistently keyed and
cross-linked, with provenance on every record.

| Entity | Source of truth | Key links | Feeds |
| --- | --- | --- | --- |
| Account | ServiceTrade | sites, invoices, jobs, quotes, contacts | Accounts + detail screens |
| Site | ServiceTrade | account, equipment, jobs | Accounts detail, Schedule |
| Invoice | ServiceTrade → **Sage Intacct** | account, job | Balances, Invoice Collector |
| Job | ServiceTrade | account, site, crew | Dispatcher, Job Costing |
| Quote | ServiceTrade | account, site | Pipeline, Closer, Estimator |
| Contract | ServiceTrade | account, sites | Plan Manager, contract type |
| Approval / agent output | **OS-native** | any entity it acts on | Approvals inbox, autopilot |

**External entities** (accounts, jobs, invoices) are mirrored — the external system is the
source of truth and the app is read-only until the toggle says otherwise. **OS-native data**
(agent drafts, approvals, notes) the app owns. Provenance keeps them from colliding: a field
carries who last wrote it, so a sync never clobbers a human edit and vice versa.

---

## 03 · The sync engine

Data that keeps itself fresh, three ways, through one path (*fetch → normalize → upsert → log*):

- Manual full re-pull → **incremental** pulls using each source's `updatedAfter` filter.
- Stale-between-syncs → **webhooks** land job/invoice/quote changes in real time (receiver built).
- No safety net → a **scheduler** runs incremental catch-up on a cron + a nightly reconcile.

The read-only/write toggle stays the gate every write passes through. Sync becomes
observable: per-entity last-synced, row counts, errors on the sync screen; the existing
conflict queue handles the rare two-sided edit.

**Already built:** the OAuth2 client, the read-only/write gate, the webhook receiver, the
background pull runner with progress, and the `source`/`sync_state` columns. v2 promotes them
from "manual, per-entity" to "automatic, incremental, scheduled."

---

## 04 · The query layer

The biggest scale gap is the list screens. v2 introduces one shared server-side list contract:

```
GET /api/<entity>?q=&filter=&sort=&page=&pageSize=
  → { rows, total, page, pageSize }
```

Backed by SQLite indexes (FTS later if needed), it powers a shared front-end list component:
a search box, filter chips, sortable columns, real pagination, honest loading/empty states.
Accounts, Sites, Pipeline, Schedule, Jobs and Invoices all adopt it. Detail screens read the
entity plus its linked records from the spine.

---

## 05 · Agents on the spine

Each agent moves from seeded tables to the live spine: the Dispatcher schedules real jobs to
real crews, the Closer chases real open quotes, Job Costing reads real logged cost against the
real quote. Outputs stay OS-native and gated — each linked to the entity it acts on, each into
the one approvals inbox. Autopilot stays off until turned on, per action.

**Sage Intacct turns on the Invoice Collector.** The ServiceTrade pull treats invoices as CRM
enrichment (balances) and leaves the Collector's operating table untouched — reserved for Sage
Intacct as the authoritative A/R source. When Intacct connects (same pattern), the Collector
starts chasing real receivables. It's a connector, not a rebuild.

---

## 06 · Decisions needed (recommendation leads each)

1. **Build-step-free, or a build step?** — *Rec:* stay build-step-free; factor a small shared
   vanilla component library (list, table, filter bar, detail shell). Revisit a light bundler
   only if component sprawl actually hurts.
2. **SQLite, or Postgres?** — *Rec:* keep SQLite; add indexes + FTS. Reconsider only if you
   outgrow one machine.
3. **Logins / multi-user?** — Every approval is stamped `decided_by: 'Devon'`; no auth. *Rec:*
   add lightweight auth when the second user appears; design the spine so attribution is ready.
4. **How far does the app's authority go?** — *Rec:* mirror external systems for external
   entities; let the app own OS-native data. Writes back stay behind the toggle *and* an approval.
5. **Keep the persistent-iframe shell?** — It keeps call audio alive across navigation and
   isn't the bottleneck. *Rec:* keep it for v2; revisit only if a single app becomes clearly simpler.

---

## 07 · Phased roadmap (strangler migration, no big-bang)

Each phase ships to `main`, deploys, and stays green, with the demo fallback intact until a
screen is fully on live data.

- **P0 · Foundations** *(in progress)* — connector framework refactor, incremental sync engine
  + scheduler, the shared list API contract, shared front-end list/table/detail components.
- **P1 · Accounts & Sites at scale** — real search/filter/sort/pagination on 2,312 accounts and
  6,130 sites; account detail from the spine; contracts pulled for contract type.
- **P2 · Finance spine → Invoice Collector** — the Sage Intacct connector; A/R as the
  authoritative invoice source; the Collector on real overdue balances (gated).
- **P3 · Delivery spine** — jobs and quotes on the spine; Dispatcher/Estimator/Closer/Plan
  Manager/Job Costing on real records.
- **P4 · Sync on autopilot** — webhooks + scheduled incremental fully live and observable; the
  conflict-resolution UI on real two-sided edits.
- **P5 · Agent autopilot & polish** — opt-in, per-action autopilot on real data (logged,
  reversible); enrichment passes (true "customer since" from first job, activity/last-touch).

---

## 08 · Risks & mitigations

- **Sync state lives in memory on one machine.** A restart mid-pull loses progress. → Persist
  job/sync state to SQLite (last cursor per entity, in-flight status) so runs resume.
- **Provider rate limits & large backfills.** `/location` paginates ~10/page (613 pages). →
  Incremental `updatedAfter` as default; throttled backfills with backoff; page-cap backstop.
- **Data-quality surprises.** "Customer since" is really record-created; internal inter-company
  LLCs sit alongside real customers; some fields blank at source. → Derive meaningful fields,
  label provenance, filter internal vs external.
- **Write-mode is where damage lives.** → The write path stays doubly gated (read-only/write
  toggle **and** a per-action approval), every write logged. No connector writes without both.
