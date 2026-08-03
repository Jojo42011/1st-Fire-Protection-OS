import { getDb } from './index';

/**
 * ONE schema source of truth. Idempotent — safe to run on every boot.
 * Never assume a column exists without a migration here.
 */
export function initDb(): void {
  const db = getDb();

  db.exec(`
    /* ---------- system ---------- */
    CREATE TABLE IF NOT EXISTS system_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    /* ---------- memory / brain ---------- */
    CREATE TABLE IF NOT EXISTS facts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      subject    TEXT NOT NULL,
      predicate  TEXT NOT NULL,
      object     TEXT NOT NULL,
      importance REAL DEFAULT 0.5,
      strength   REAL DEFAULT 1.0,
      embedding  TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent      TEXT,
      summary    TEXT NOT NULL,
      detail     TEXT,
      importance REAL DEFAULT 0.5,
      embedding  TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      kind  TEXT,
      UNIQUE(label, kind)
    );
    CREATE TABLE IF NOT EXISTS edges (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      src      INTEGER NOT NULL,
      dst      INTEGER NOT NULL,
      relation TEXT NOT NULL,
      weight   REAL DEFAULT 1.0,
      FOREIGN KEY (src) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (dst) REFERENCES nodes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      rule       TEXT NOT NULL,
      scope      TEXT,
      active     INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS syntheses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      insight    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    /* ---------- the calibration ledger (the Operator's metacognition) ----------
     * Every stake-worthy claim the Operator makes (a gap, a value line, a forecast) is
     * logged here with a stated confidence and a measurable predicted outcome. When the
     * outcome becomes knowable a human resolves it; calibration is then computed on read
     * from RESOLVED rows only (confirmed=1, partial=0.5, refuted=0). Nothing here is a
     * background job. 'sample' flags illustrative seed rows so the UI never shows a
     * seeded resolution as a verified real one. */
    CREATE TABLE IF NOT EXISTS predictions (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_kind           TEXT,                       -- gap|value|forecast
      ref_id               TEXT,                       -- audit_findings.id when applicable
      statement            TEXT,
      predicted_confidence REAL,                       -- 0..1 (as stated, before the discount)
      predicted_outcome    TEXT,
      horizon_at           TEXT,                       -- when we expect to know
      status               TEXT DEFAULT 'open',        -- open|confirmed|refuted|partial
      actual_outcome       TEXT,
      resolved_by          TEXT,
      resolved_at          TEXT,
      sample               INTEGER DEFAULT 0,          -- 1 = illustrative seed row (labeled in UI)
      created_at           TEXT DEFAULT (datetime('now'))
    );

    /* ---------- invoice collector ---------- */
    CREATE TABLE IF NOT EXISTS invoices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      customer        TEXT NOT NULL,
      email           TEXT,
      phone           TEXT,
      amount          REAL NOT NULL,
      issued_at       TEXT,
      due_at          TEXT,
      status          TEXT DEFAULT 'sent',   -- draft|sent|reminded|paid
      last_reminder_at TEXT,
      paid_at         TEXT,
      notes           TEXT
    );
    CREATE TABLE IF NOT EXISTS invoice_reminders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      tier       TEXT,                        -- friendly|firm|final
      body       TEXT NOT NULL,
      status     TEXT DEFAULT 'draft',        -- draft|approved|sent
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    /* ---------- collection workflow (daily dunning until paid) ----------
     * Enrolling an overdue invoice is the human gate. Once enrolled, the daily
     * cycle drafts + sends an outstanding-balance email AND text every day until
     * the invoice is marked paid (then the workflow auto-completes). */
    CREATE TABLE IF NOT EXISTS invoice_workflow (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id  INTEGER NOT NULL UNIQUE,
      status      TEXT DEFAULT 'active',       -- active|paused|done|stopped
      channels    TEXT DEFAULT 'email,sms',    -- csv of channels to hit each day
      day_count   INTEGER DEFAULT 0,           -- how many daily cycles have run
      started_at  TEXT DEFAULT (datetime('now')),
      last_run_at TEXT,
      next_run_at TEXT,                         -- when the next daily cycle is due
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS invoice_workflow_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL,
      invoice_id  INTEGER NOT NULL,
      day         INTEGER,                      -- which daily cycle (1-based)
      channel     TEXT,                         -- email|sms
      tier        TEXT,                         -- friendly|firm|final
      destination TEXT,                         -- the email / phone it went to
      body        TEXT,
      status      TEXT DEFAULT 'simulated',     -- sent|simulated|skipped|failed
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workflow_id) REFERENCES invoice_workflow(id) ON DELETE CASCADE
    );

    /* ---------- review collector ---------- */
    CREATE TABLE IF NOT EXISTS jobs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      customer   TEXT NOT NULL,
      job_desc   TEXT,
      completed_at TEXT,
      requested  INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS review_requests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id     INTEGER,
      customer   TEXT NOT NULL,
      job_desc   TEXT,
      channel    TEXT,                        -- email|sms
      body       TEXT NOT NULL,
      status     TEXT DEFAULT 'draft',        -- draft|approved|sent
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT,                      -- google|yelp|facebook
      author       TEXT,
      stars        INTEGER,
      text         TEXT,
      received_at  TEXT,
      reply_draft  TEXT,
      reply_status TEXT DEFAULT 'none'        -- none|draft|approved|published
    );

    /* ---------- call receptionist ---------- */
    CREATE TABLE IF NOT EXISTS calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_number TEXT,
      started_at  TEXT,
      duration    INTEGER,                    -- seconds
      transcript  TEXT,
      intent      TEXT,
      outcome     TEXT                        -- booked|message|transferred|missed
    );
    CREATE TABLE IF NOT EXISTS leads (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT,
      phone      TEXT,
      address    TEXT,
      need       TEXT,
      source     TEXT,
      status     TEXT DEFAULT 'new',          -- new|booked|contacted|closed
      created_at TEXT DEFAULT (datetime('now'))
    );

    /* ---------- conversation log (brain chat) ---------- */
    CREATE TABLE IF NOT EXISTS conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      role       TEXT,
      content    TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    /* ---------- the operator (operational audit) ---------- */
    CREATE TABLE IF NOT EXISTS audit_pillars (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      key      TEXT NOT NULL UNIQUE,          -- 'inspections', 'finance', ...
      name     TEXT NOT NULL,
      tagline  TEXT,
      sort     INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS audit_locations (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT NOT NULL UNIQUE,
      role    TEXT,                            -- 'HQ' | 'branch'
      notes   TEXT,
      mapped  INTEGER DEFAULT 0                -- has the audit touched this site yet
    );
    CREATE TABLE IF NOT EXISTS audit_systems (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      category   TEXT,                         -- field-service | accounting | comms | spreadsheet ...
      owner      TEXT,
      truth_for  TEXT,                         -- what it's the source of truth for
      gaps       TEXT,                         -- what it doesn't talk to / manual hand-offs
      pillar_key TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_people (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      role       TEXT,
      location   TEXT,
      carries    TEXT,                         -- the knowledge only they hold
      risk       TEXT DEFAULT 'low',           -- low|medium|high (single-point-of-failure)
      pillar_key TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_workflows (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      trigger_desc TEXT,                       -- what kicks it off
      stalls      TEXT,                        -- where it stalls / breaks
      pillar_key  TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_findings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pillar_key    TEXT,
      kind          TEXT DEFAULT 'leak',       -- leak|risk|gap|strength
      title         TEXT NOT NULL,
      detail        TEXT,                      -- why it matters (benchmark-cited)
      severity      TEXT DEFAULT 'medium',     -- low|medium|high|critical
      cost_hint     TEXT,
      capability_id TEXT,                      -- matched build from the catalog
      status        TEXT DEFAULT 'open',       -- open|dismissed|building
      source_note_id INTEGER,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_nodes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pillar_key    TEXT NOT NULL,
      name          TEXT NOT NULL,
      caption       TEXT,                       -- one plain line: what this agent does for THEM
      connects      TEXT,                       -- JSON array: systems/people this node wires to
      capability_id TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(pillar_key, name)
    );
    CREATE TABLE IF NOT EXISTS audit_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,                -- what the CEO/staff actually said
      location   TEXT,                         -- which site it was about (optional)
      analysis   TEXT,                         -- JSON: the operator's full read
      created_at TEXT DEFAULT (datetime('now'))
    );

    /* The interview ladder — persisted so the audit RESUMES and DEEPENS across
       sessions instead of living in browser memory. Each answer stores here and
       queues a sharper follow-up one depth level down. */
    CREATE TABLE IF NOT EXISTS audit_questions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      question       TEXT NOT NULL,
      pillar_key     TEXT,
      depth_level    INTEGER DEFAULT 0,         -- 0 = opening deck; +1 per follow-up
      asked_of       TEXT,                      -- role/person the question targets (optional)
      status         TEXT DEFAULT 'open',       -- open | answered
      answer         TEXT,
      source_note_id INTEGER,                   -- the note this question's answer created
      created_at     TEXT DEFAULT (datetime('now')),
      answered_at    TEXT
    );

    /* Daily "getting smarter" log — one row per day, so the OS can show that the
       longer it runs, the more of the company lives inside it. */
    CREATE TABLE IF NOT EXISTS audit_days (
      day           TEXT PRIMARY KEY,           -- YYYY-MM-DD
      facts_learned INTEGER DEFAULT 0,          -- observations captured that day
      coverage_pct  INTEGER DEFAULT 0           -- overall coverage snapshot at day end
    );

    /* THE HARNESS — the execution layer over the Operator's build queue.
       When a human approves a gap (audit_findings.queue_status='approved'), the
       harness picks it up, drafts a build order (the plan to fix it), and stages it
       for a final human ship. This is the OS proposing AND building its own next
       steps, gated by a person at each hop. */
    CREATE TABLE IF NOT EXISTS build_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      finding_id    INTEGER,                    -- the approved gap this builds
      capability_id TEXT,                       -- the matched build from the catalog
      title         TEXT NOT NULL,
      plan          TEXT,                       -- JSON: the drafted agent spec (persona, skills) or step plan
      value_line    TEXT,                       -- the business case, carried from the gap
      eta_weeks     INTEGER DEFAULT 2,
      status        TEXT DEFAULT 'staged',      -- staged (drafted, awaiting ship) | shipped
      engine        TEXT DEFAULT 'harness-rules', -- harness-rules | harness-llm
      created_at    TEXT DEFAULT (datetime('now')),
      shipped_at    TEXT
    );

    /* THE ROSTER — every AI employee this OS runs, founding + harness-built.
       An agent here is data the generic runtime executes: a persona (system_prompt),
       the pillar it serves, its capability, and a growing knowledge/skill list. The
       Operator proposes the need; the Harness drafts and (on a human ship) inserts a
       live agent here; every other tool in the OS can then see and route to it. This
       is how the OS grows its own team instead of shipping a fixed template. */
    CREATE TABLE IF NOT EXISTS agents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key           TEXT UNIQUE NOT NULL,       -- slug (console id)
      name          TEXT NOT NULL,
      role          TEXT,                       -- one-line job
      pillar_key    TEXT,                       -- the department it serves
      capability_id TEXT,                       -- the catalog build it embodies
      system_prompt TEXT,                       -- the drafted persona/instructions the runtime runs
      knowledge     TEXT,                       -- JSON array of knowledge/skill lines (grows on upgrade)
      origin        TEXT DEFAULT 'harness',     -- founding | harness
      status        TEXT DEFAULT 'live',        -- live | draft | retired
      built_from    INTEGER,                    -- the build_orders.id that created it (harness-built)
      created_at    TEXT DEFAULT (datetime('now'))
    );

    /* THE STRENGTHEN LOG — every skill the harness has added to an agent (new or
       existing). Makes "the OS is getting smarter" literal and auditable. */
    CREATE TABLE IF NOT EXISTS agent_skills (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_key    TEXT NOT NULL,
      skill        TEXT NOT NULL,
      source_order INTEGER,                     -- the build_orders.id that added it
      created_at   TEXT DEFAULT (datetime('now'))
    );

    /* ---------- license reclaim (HR roster reconciled against software seats) ----------
     * The active roster (from BambooHR, or the seeded fallback when keyless) is reconciled
     * against the software-license seat inventory. Any seat assigned to someone who is NOT
     * on the active roster (terminated, or gone entirely) is a RECLAIMABLE license, and the
     * per-seat cost is money that can be recovered. Reclaim is human-gated (propose ->
     * approve); nothing here ever cancels a license automatically. */
    CREATE TABLE IF NOT EXISTS hr_employees (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name     TEXT NOT NULL,
      email         TEXT UNIQUE,
      department    TEXT,
      title         TEXT,
      status        TEXT DEFAULT 'active',       -- active|terminated
      hired_at      TEXT,
      terminated_at TEXT,
      source        TEXT DEFAULT 'seed',         -- seed|bamboo
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS license_seats (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor         TEXT NOT NULL,              -- adobe|bluebeam|autocad|hydracad|hfss|microsoft
      product        TEXT,
      assignee_email TEXT,
      assignee_name  TEXT,
      cost_monthly   REAL DEFAULT 0,
      assigned_at    TEXT,
      source         TEXT DEFAULT 'seed',        -- seed|manual|graph|umapi|autodesk|bluebeam|hydracad|hfss
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS license_reclaims (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      seat_id         INTEGER NOT NULL,
      status          TEXT DEFAULT 'proposed',   -- proposed|approved|reclaimed
      reason          TEXT,
      savings_monthly REAL DEFAULT 0,
      proposed_at     TEXT DEFAULT (datetime('now')),
      approved_at     TEXT,
      reclaimed_at    TEXT,
      FOREIGN KEY (seat_id) REFERENCES license_seats(id) ON DELETE CASCADE
    );

    /* ---------- new-hire onboarding (intake -> auto-routed, human-gated work) ----------
     * One intake form captures every onboarding field for a new employee. On submit the
     * router fans the SET/CHECKED fields out into onboarding_items, each addressed to the
     * right owner as either a task (do it) or an approval (a human must say yes). Nothing
     * here calls an external system: the BambooHR items are routed tasks a person acts on,
     * and every approval is an explicit human click. A request completes when no item is
     * still pending. */
    CREATE TABLE IF NOT EXISTS onboarding_requests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      personal_email    TEXT,
      start_date        TEXT,
      cell_phone        TEXT,
      job_position      TEXT,
      salary            TEXT,
      manager_name      TEXT,
      company_email     INTEGER DEFAULT 0,   -- IT: provision a company email
      teams_number      INTEGER DEFAULT 0,   -- IT: provision a Teams number
      cell_reimburse    INTEGER DEFAULT 0,   -- BambooHR: cell-phone reimbursement
      pto_plan          INTEGER DEFAULT 0,   -- BambooHR: a different PTO plan
      hours_80_40       INTEGER DEFAULT 0,   -- BambooHR: 80-vs-40 hours approved
      probation_waived  INTEGER DEFAULT 0,   -- BambooHR: 60-day probation waived
      incentive_plan    INTEGER DEFAULT 0,   -- BambooHR: incentive plan
      vehicle_allowance INTEGER DEFAULT 0,   -- BambooHR: vehicle allowance (Sandi builds into pay)
      misc_exceptions   TEXT,                -- BambooHR: free-text pay/HR exception
      company_cell      INTEGER DEFAULT 0,   -- Safety (Denise): company cell phone
      ipad              INTEGER DEFAULT 0,   -- Safety (Denise): company iPad
      company_vehicle   INTEGER DEFAULT 0,   -- fans out to Sandi + Denise + Daniel
      vehicle_details   TEXT,                -- the vehicle / new-vehicle details
      vehicle_transfer  INTEGER DEFAULT 0,   -- Safety (Denise): company vehicle transfer
      wex_card          INTEGER DEFAULT 0,   -- Safety (Denise): WEX fuel card
      computer_type     TEXT DEFAULT 'none', -- none|standard|business|cad (Mario approval when not none)
      software_json     TEXT DEFAULT '[]',   -- selected software (routed per item: IT or Mario)
      sharepoint_json   TEXT DEFAULT '[]',   -- selected SharePoint groups (routed per group)
      printers_json     TEXT DEFAULT '[]',   -- selected printers (IT)
      status            TEXT DEFAULT 'open', -- open|complete
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS onboarding_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id  INTEGER NOT NULL,
      owner       TEXT NOT NULL,               -- bamboo|it|mario|rebecca|sandi|denise|daniel
      owner_label TEXT NOT NULL,               -- display name for the owner
      kind        TEXT NOT NULL,               -- task|approval
      label       TEXT NOT NULL,               -- what needs doing
      detail      TEXT,                        -- the specifics carried from the form
      status      TEXT DEFAULT 'pending',      -- pending|done|approved|rejected
      decided_by  TEXT,                        -- who completed/approved/rejected it
      decided_at  TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (request_id) REFERENCES onboarding_requests(id) ON DELETE CASCADE
    );
  `);

  /* ---------- migrations: extra call-analytics columns (Vapi) ----------
   * Added after the base table so existing brains upgrade in place. Idempotent —
   * addColumn checks pragma table_info first (SQLite has no ADD COLUMN IF NOT EXISTS). */
  addColumn('calls', 'vapi_call_id', 'TEXT');           // provider call id (idempotency key)
  addColumn('calls', 'assistant_id', 'TEXT');           // which Vapi assistant answered
  addColumn('calls', 'ended_at', 'TEXT');               // ISO end timestamp
  addColumn('calls', 'ended_reason', 'TEXT');           // hangup / forwarded / voicemail ...
  addColumn('calls', 'cost', 'REAL DEFAULT 0');         // total $ for the call
  addColumn('calls', 'cost_breakdown', 'TEXT');         // JSON: {transport,stt,llm,tts,vapi,...}
  addColumn('calls', 'summary', 'TEXT');                // provider/analysis summary
  addColumn('calls', 'messages', 'TEXT');               // JSON: full message log [{role,message,...}]
  addColumn('calls', 'recording_url', 'TEXT');          // mono recording (playable)
  addColumn('calls', 'stereo_recording_url', 'TEXT');   // stereo recording
  addColumn('calls', 'success_evaluation', 'TEXT');     // analysis success signal
  addColumn('calls', 'structured_data', 'TEXT');        // JSON: analysis structuredData

  // One provider call = one row. NULL ids are allowed to repeat (seed/manual rows).
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_vapi_id
       ON calls(vapi_call_id) WHERE vapi_call_id IS NOT NULL;`
  );

  /* ---------- the gap feed / build queue (the seed of the in-OS harness) ----------
   * A matched finding is a PROPOSED build. A human approves it -> it becomes a work
   * order the OS can act on. Added as columns so existing brains upgrade in place. */
  addColumn('audit_findings', 'queue_status', "TEXT DEFAULT 'proposed'"); // proposed|approved|building|shipped
  addColumn('audit_findings', 'value_line', 'TEXT');                       // the one-line business case

  /* ---------- the harness -> roster wiring (added after Build C shipped) ----------
   * A build order now either CREATES a new agent or STRENGTHENS an existing one.
   * Columns so dev DBs that already have build_orders upgrade in place. */
  addColumn('build_orders', 'mode', "TEXT DEFAULT 'new'");   // new (build an agent) | upgrade (strengthen one)
  addColumn('build_orders', 'target_agent_key', 'TEXT');     // the agent an upgrade strengthens

  /* ---------- the coder: real code the harness writes for a new agent ----------
   * A reviewable artifact (a human merges it via the dev pipeline; never hot-loaded). */
  addColumn('build_orders', 'code', 'TEXT');          // the generated TypeScript module
  addColumn('build_orders', 'code_path', 'TEXT');     // where it would live in the repo
  addColumn('build_orders', 'code_engine', 'TEXT');   // coder-kimi | coder-anthropic | template ...

  // Every harness-built agent runs its own sub-dashboard (nested under its department dashboard),
  // not just a chat console. 'console' keeps any pre-existing built agents as-is; new builds set
  // 'dashboard' at creation. Founding agents keep their own bespoke dashboards regardless.
  addColumn('agents', 'dashboard_kind', "TEXT DEFAULT 'console'");

  /* ---------- the associative memory layer (decaying association graph) ----------
   * The existing typed edges (relation != 'assoc') are untouched. Associative edges
   * (relation = 'assoc') carry a weight that is reinforced on real co-activation and
   * decayed lazily at read from last_reinforced_at. 'weight' already exists on edges;
   * these add the decay timestamp and the illustrative-seed flag. */
  addColumn('edges', 'last_reinforced_at', 'TEXT');
  addColumn('edges', 'sample', 'INTEGER DEFAULT 0'); // 1 = illustrative seed edge (labeled in UI)

  /* One-time reconciliation of the license inventory to the corrected vendor set.
   * The retired 'hydrocad' seats become 'hydracad' (the right product, Hydratec sprinkler
   * design), and HFSS seats are backfilled onto an inventory that was seeded before HFSS
   * existed. A fresh database gets both straight from the seed, so this is a no-op there
   * (it runs before the seat data exists). Idempotent, guarded by a state flag. */
  if (getState('mig_license_vendors_v2') !== '1') {
    db.prepare("UPDATE license_seats SET vendor = 'hydracad', product = 'HydraCAD (Hydratec)' WHERE vendor = 'hydrocad'").run();
    const seatCount = (db.prepare('SELECT COUNT(*) AS c FROM license_seats').get() as { c: number }).c;
    const hfssCount = (db.prepare("SELECT COUNT(*) AS c FROM license_seats WHERE vendor = 'hfss'").get() as { c: number }).c;
    if (seatCount > 0 && hfssCount === 0) {
      const addHfss = db.prepare(
        "INSERT INTO license_seats (vendor, product, assignee_email, assignee_name, cost_monthly, assigned_at, source) VALUES ('hfss', 'HFSS', ?, ?, 20, ?, 'seed')"
      );
      addHfss.run('victor.delgado@1stfp.example', 'Victor Delgado', '2025-06-01');
      addHfss.run('jordan.pratt@1stfp.example', 'Jordan Pratt', '2025-02-15');
    }
    setState('mig_license_vendors_v2', '1');
  }

  /* One-time cleanup of dash punctuation in the persisted consult questions. The deck was
   * seeded before the no-dash rule was applied to the department copy, so already-seeded
   * question rows still carry an em dash (' — ') or an en dash ('–'). The chips are matched
   * to a question by its exact text at render time, so a stale dash both shows on screen and
   * breaks the chip lookup against the corrected config. This rewrites the persisted text to
   * match. A fresh database seeds the clean text directly, so this is a harmless no-op there.
   * Idempotent, guarded by a state flag. */
  if (getState('mig_dash_strip_v1') !== '1') {
    db.prepare("UPDATE audit_questions SET question = REPLACE(question, ' — ', ', ')").run();
    db.prepare("UPDATE audit_questions SET question = REPLACE(question, '–', '-')").run();
    setState('mig_dash_strip_v1', '1');
  }

  /* ---------- approvals inbox (Signal Phase 3) ----------
   * One queue for every gated action across all agents. The individual agents keep
   * their own status columns (invoice_reminders, reviews.reply_status, license_reclaims)
   * for their own pages, and additionally write an approvals row so the cross-agent
   * inbox and the "needs your yes" badge have a single source of truth. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_key     TEXT NOT NULL,           -- 'invoices' | 'reviews' | 'licenses' | 'calls' | 'crm'
      kind          TEXT NOT NULL,           -- 'send_email' | 'send_sms' | 'publish' | 'cancel_seat' | 'push_st' | 'quote_price'
      risk          TEXT NOT NULL,           -- 'routine' | 'sensitive'
      title         TEXT NOT NULL,
      stake         TEXT,                    -- '$34,800' | 'saves $1,752/yr'
      body          TEXT,                    -- the actual draft the human reads
      trail         TEXT,                    -- 'Goes to marcy.d@alamoridge.com + AP inbox'
      subject_type  TEXT,                    -- 'invoice' | 'review' | 'seat' | 'account'
      subject_id    INTEGER,
      status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | skipped | expired
      decided_by    TEXT,
      decided_at    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_open ON approvals(status, created_at);

    CREATE TABLE IF NOT EXISTS approval_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id INTEGER NOT NULL,
      action      TEXT NOT NULL,             -- 'approved' | 'skipped' | 'executed'
      detail      TEXT,
      at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  /* ---------- CRM mirror of ServiceTrade (Signal Phase 4, shell only) ----------
   * Tables mirror ServiceTrade's shape and carry sync bookkeeping on every row. This
   * pass is a shell: ServiceTrade is NOT called, every read serves fixtures and reports
   * live:false. Outbound writes go through sync_queue, never inline. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      st_id TEXT UNIQUE, name TEXT NOT NULL, segment TEXT,
      contract_type TEXT, contract_renews_at TEXT, owner_user TEXT,
      customer_since TEXT, balance_cents INTEGER DEFAULT 0,
      lifetime_cents INTEGER DEFAULT 0, avg_days_to_pay INTEGER,
      risk TEXT, last_touch_at TEXT, last_touch_kind TEXT,
      st_updated_at TEXT, local_updated_at TEXT, sync_state TEXT DEFAULT 'clean'
    );
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT, st_id TEXT UNIQUE,
      account_id INTEGER NOT NULL, name TEXT, address TEXT,
      system_type TEXT, next_service_at TEXT, last_result TEXT,
      st_updated_at TEXT, local_updated_at TEXT, sync_state TEXT DEFAULT 'clean'
    );
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT, st_id TEXT UNIQUE,
      site_id INTEGER NOT NULL, kind TEXT, count INTEGER,
      due_at TEXT, st_updated_at TEXT, sync_state TEXT DEFAULT 'clean'
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, st_id TEXT UNIQUE,
      account_id INTEGER NOT NULL, name TEXT, role TEXT,
      email TEXT, phone TEXT, is_primary INTEGER DEFAULT 0, is_billing INTEGER DEFAULT 0,
      source TEXT, st_updated_at TEXT, local_updated_at TEXT, sync_state TEXT DEFAULT 'clean'
    );
    CREATE TABLE IF NOT EXISTS crm_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, st_id TEXT UNIQUE,
      account_id INTEGER, site_id INTEGER, number TEXT, kind TEXT,
      status TEXT, tech TEXT, scheduled_at TEXT, completed_at TEXT,
      deficiency_count INTEGER DEFAULT 0, st_updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, st_id TEXT UNIQUE,
      account_id INTEGER, site_id INTEGER, number TEXT, title TEXT,
      amount_cents INTEGER, stage TEXT,
      origin TEXT, sent_at TEXT, opened_count INTEGER DEFAULT 0, snooze_until TEXT,
      lost_reason TEXT, st_updated_at TEXT, local_updated_at TEXT, sync_state TEXT DEFAULT 'clean'
    );
    CREATE TABLE IF NOT EXISTS account_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      tag TEXT NOT NULL, title TEXT, body TEXT, source TEXT, meta TEXT,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_account ON account_events(account_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS sync_objects (
      object TEXT PRIMARY KEY, label TEXT, detail TEXT,
      direction TEXT NOT NULL, policy TEXT NOT NULL,
      enabled INTEGER DEFAULT 1, record_count INTEGER DEFAULT 0,
      last_pull_at TEXT, last_push_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object TEXT NOT NULL, local_id INTEGER, st_id TEXT,
      op TEXT NOT NULL, payload TEXT NOT NULL,
      idempotency_key TEXT UNIQUE NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER DEFAULT 0, last_error TEXT,
      needs_approval INTEGER DEFAULT 0, approval_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')), sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object TEXT NOT NULL, local_id INTEGER, st_id TEXT, field TEXT NOT NULL,
      their_value TEXT, their_updated_at TEXT,
      our_value TEXT, our_updated_at TEXT, our_origin TEXT,
      status TEXT DEFAULT 'open',
      resolved_by TEXT, resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL, text TEXT NOT NULL, state TEXT,
      object TEXT, at TEXT DEFAULT (datetime('now'))
    );
  `);

  /* ---------- The Estimator (five-agents delta, Phase 2) ----------
   * A takeoff is the vision read (items + per-item confidence); the Estimator prices it
   * off the rate card into the existing `quotes` table. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS takeoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer TEXT, address TEXT,
      source TEXT,                    -- 'photos' | 'blueprint'
      asset_count INTEGER,            -- 14 photos / 3 sheets
      scale_ref TEXT,                 -- '36in entry door'
      items_json TEXT,                -- [{item,where,count,unit,confidence,flag}]
      confidence REAL,                -- rolled up
      status TEXT DEFAULT 'read',     -- 'read' | 'flagged' | 'quoted'
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // The Estimator writes the takeoff + its priced line items back onto a quote row.
  addColumn('quotes', 'takeoff_id', 'INTEGER');
  addColumn('quotes', 'line_items_json', 'TEXT');

  /* ---------- The Closer (five-agents delta, Phase 3) ----------
   * Chases every open quote on a cadence; logs why each lost quote was lost so the
   * "why we lose" panel can graduate into the shared context library. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS closer_touches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id INTEGER NOT NULL,
      channel TEXT,                   -- 'email' | 'sms' | 'call_script'
      tier TEXT,                      -- 'nudge' | 'value' | 'last_call'
      body TEXT,
      status TEXT DEFAULT 'draft',    -- 'draft' | 'sent'
      scheduled_at TEXT, sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS lost_reasons (
      quote_id INTEGER PRIMARY KEY,
      reason TEXT,                    -- 'price' | 'incumbent' | 'budget_cycle' | 'too_slow' | 'none'
      detail TEXT, logged_at TEXT DEFAULT (datetime('now'))
    );
  `);

  /* ---------- Service plans (five-agents delta, Phase 4) ----------
   * Turns finished jobs into recurring agreements, schedules the visits (through the
   * Dispatcher) and renews them before they lapse. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_agreements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER, customer TEXT,
      plan_type TEXT, interval_days INTEGER, price INTEGER,
      status TEXT DEFAULT 'active',   -- 'active' | 'lapsing' | 'cancelled'
      started_at TEXT, next_service_at TEXT, renews_at TEXT
    );
    CREATE TABLE IF NOT EXISTS service_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agreement_id INTEGER, scheduled_at TEXT, status TEXT
    );
  `);

  /* ---------- The Dispatcher (five-agents delta, Phase 5) ----------
   * Matches each job to the right crew by skill, zone and spare capacity, cuts no-shows with
   * two reminders per visit, and backfills a cancellation from the waitlist. Appointments are
   * stored by day-of-week (0=Mon..4=Fri) so the crew-week grid always reads as "this week"
   * however long the fixture has been sitting in the DB. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS crews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      skills TEXT,                    -- csv from TRADE_CONFIG.dispatch.skills
      zone TEXT,                      -- the service area this crew works
      capacity_per_day INTEGER DEFAULT 3,
      load_pct INTEGER DEFAULT 0      -- this week's utilization (fixture)
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crew_id INTEGER, customer TEXT, site TEXT, skill TEXT,
      dow INTEGER,                    -- 0=Mon .. 4=Fri (rendered against the current week)
      window TEXT,                    -- '8–12'
      status TEXT DEFAULT 'confirmed' -- 'proposed' | 'confirmed' | 'done' | 'no_show'
    );
    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rank INTEGER, customer TEXT, need TEXT, skill TEXT,
      flexibility TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  /* ---------- Job Costing (five-agents delta, Phase 6) ----------
   * Tracks logged cost (labour hours × rate, material, subs) against the quoted price per job.
   * The MARGIN IS NEVER STORED — it is computed on read as quoted − cost, so changing a cost
   * moves the number and nothing goes stale. A bleeding job's out-of-scope overrun becomes a
   * drafted change order (gated). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer TEXT NOT NULL, work TEXT,
      quoted_cents INTEGER,
      labor_hrs REAL DEFAULT 0,        -- hours logged so far
      labor_quoted_hrs REAL DEFAULT 0, -- hours the quote assumed (for the overrun line)
      material_cents INTEGER DEFAULT 0,
      sub_cents INTEGER DEFAULT 0,
      sub_label TEXT,                  -- e.g. 'backflow cert'
      status TEXT DEFAULT 'in_progress', -- 'in_progress' | 'closed'
      note TEXT,                       -- short human read of where it moved
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  /* ---------- ServiceTrade webhook inbox ----------
   * Real-time events ServiceTrade PUSHES to us (job completed, invoice created, quote updated…)
   * over its native webhook API — no Zapier. This is a read-side landing table: events are
   * recorded here as they arrive; routing them to agents (which then DRAFT, gated) comes later.
   * Receiving never writes back to ServiceTrade, so it's safe under read-only mode. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS servicetrade_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT,                     -- 'created' | 'updated' | 'deleted'
      entity_type TEXT,                -- job | invoice | quote | ... (as sent)
      entity_id TEXT,
      payload_json TEXT,               -- the raw event body
      processed INTEGER DEFAULT 0,     -- 0 until an agent has acted on it
      received_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Distinguish demo-seed CRM rows from records pulled live from ServiceTrade, so the screens
  // can flip to real data once a pull has happened without deleting the keyless demo dataset.
  addColumn('accounts', 'source', "TEXT DEFAULT 'seed'"); // 'seed' | 'servicetrade'
}

/** Add a column only if it isn't already present (idempotent migration helper). */
function addColumn(table: string, column: string, definition: string): void {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function getState(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM system_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setState(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value);
}
