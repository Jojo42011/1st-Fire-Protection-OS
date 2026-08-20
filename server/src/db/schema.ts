import { getDb } from './index';

/**
 * ONE schema source of truth. Idempotent - safe to run on every boot.
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

    /* The interview ladder - persisted so the audit RESUMES and DEEPENS across
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

    /* Daily "getting smarter" log - one row per day, so the OS can show that the
       longer it runs, the more of the company lives inside it. */
    CREATE TABLE IF NOT EXISTS audit_days (
      day           TEXT PRIMARY KEY,           -- YYYY-MM-DD
      facts_learned INTEGER DEFAULT 0,          -- observations captured that day
      coverage_pct  INTEGER DEFAULT 0           -- overall coverage snapshot at day end
    );

    /* THE HARNESS - the execution layer over the Operator's build queue.
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

    /* THE ROSTER - every AI employee this OS runs, founding + harness-built.
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

    /* THE STRENGTHEN LOG - every skill the harness has added to an agent (new or
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

  /* ---------- partner cross-sell: sites a fire tech flags for VDS (security) ----------
   * The highest-intent security lead there is: a trusted Northstar tech standing inside a
   * commercial building noting it has old or no cameras. Flows to the VDS OS via the
   * key-gated partner export. This is a deliberate, sanctioned sister-company channel;
   * only Northstar's own observations cross, never anything else. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS partner_flags (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company     TEXT NOT NULL,               -- the site / business name
      address     TEXT,
      contact     TEXT,
      note        TEXT,                        -- what the tech saw (old cameras, no access control, etc.)
      photo_url   TEXT,
      flagged_by  TEXT,                        -- tech name
      status      TEXT DEFAULT 'new',          -- new|sent
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  /* ---------- after-hours on-call roster (per office, weekly rotation) ----------
   * The AI receptionist's after-hours flow reads "who is on call for THIS office right
   * now" from here. One row is one shift: a person covering an office over a date window.
   * A weekly rotation is just a run of consecutive one-week shifts cycling through a pool.
   * starts_on is inclusive, ends_on is exclusive (the next shift's start), both local dates.
   * person_phone is the E.164 line the assistant warm-transfers to. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS oncall_shifts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      office        TEXT NOT NULL,               -- friendly office label (Riverton, Fairview, ...)
      person_name   TEXT NOT NULL,
      person_phone  TEXT,                        -- E.164 the assistant dials for a warm transfer
      person_email  TEXT,                        -- Teams identity
      starts_on     TEXT NOT NULL,               -- inclusive local date (YYYY-MM-DD)
      ends_on       TEXT NOT NULL,               -- exclusive local date (YYYY-MM-DD)
      note          TEXT,
      source        TEXT DEFAULT 'manual',       -- manual|rotation
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_oncall_office_dates ON oncall_shifts(office, starts_on, ends_on);
  `);

  /* ---------- intake links (tokenised, single-use onboarding invites) ----------
   * A hiring manager needs no OS account: they receive a single-use token link, fill the 5-step
   * intake form, and submitting generates the onboarding request. Lifecycle is derived from the
   * timestamps; a token is dead once it is submitted, voided (superseded by a resend), or expired
   * (7 days). status is stored for fast listing but recomputed on read so expiry is always honest. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS intake_links (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      token          TEXT UNIQUE NOT NULL,
      job_title      TEXT,
      office         TEXT,
      recipient_name TEXT,
      recipient_email TEXT,
      status         TEXT NOT NULL DEFAULT 'sent',   -- sent | opened | submitted | voided | expired
      created_by     TEXT,
      sent_at        TEXT DEFAULT (datetime('now')),
      opened_at      TEXT,
      submitted_at   TEXT,
      nudged_at      TEXT,
      voided_at      TEXT,
      expires_at     TEXT NOT NULL,
      submission_json TEXT,
      request_id     INTEGER                         -- onboarding request created on submit
    );
    CREATE INDEX IF NOT EXISTS idx_intake_links_status ON intake_links(status, expires_at);
  `);

  /* ---------- role module permissions (overrides over the coded presets) ----------
   * The Access role matrix. Each row overrides one role's level for one module (0 none, 1 view,
   * 2 view and edit). Absent rows fall back to the preset in people/permissions.ts, so the table
   * only stores what an admin has changed. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_modules (
      role       TEXT NOT NULL,
      module     TEXT NOT NULL,
      level      INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (role, module)
    );
  `);

  /* ---------- open-deficiency backlog (ServiceTrade repairs waiting to be quoted) ----------
   * Deficiencies are the un-converted repair work techs already found. Mirrored from the
   * ServiceTrade /deficiency API so the backlog is office-filterable and fast; office is derived
   * from the account's jobs (same proxy as quotes). proposed_usd is the estimated repair dollars. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS deficiencies (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      st_id         INTEGER UNIQUE,
      account_id    INTEGER,
      company_st_id INTEGER,
      job_st_id     INTEGER,
      company_name  TEXT,
      location_name TEXT,
      description   TEXT,
      status        TEXT,
      severity      TEXT,
      proposed_usd  REAL DEFAULT 0,
      quoted        INTEGER DEFAULT 0,
      office        TEXT,
      reported_at   TEXT,
      st_updated_at TEXT,
      source        TEXT DEFAULT 'servicetrade',
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deficiencies_office_status ON deficiencies(office, status);
  `);

  /* ---------- migrations: extra call-analytics columns (Vapi) ----------
   * Added after the base table so existing brains upgrade in place. Idempotent -
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

  // deficiency->quote linkage + real value (added after the base deficiencies table shipped)
  addColumn('deficiencies', 'job_st_id', 'INTEGER');
  addColumn('deficiencies', 'quoted', 'INTEGER DEFAULT 0');

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
      addHfss.run('victor.delgado@northstardemo.example', 'Vince Delano', '2025-06-01');
      addHfss.run('jordan.pratt@northstardemo.example', 'Jared Pope', '2025-02-15');
    }
    setState('mig_license_vendors_v2', '1');
  }

  /* One-time cleanup of dash punctuation in the persisted consult questions. The deck was
   * seeded before the no-dash rule was applied to the department copy, so already-seeded
   * question rows still carry an em dash (' - ') or an en dash ('-'). The chips are matched
   * to a question by its exact text at render time, so a stale dash both shows on screen and
   * breaks the chip lookup against the corrected config. This rewrites the persisted text to
   * match. A fresh database seeds the clean text directly, so this is a harmless no-op there.
   * Idempotent, guarded by a state flag. */
  if (getState('mig_dash_strip_v1') !== '1') {
    db.prepare("UPDATE audit_questions SET question = REPLACE(question, ' - ', ', ')").run();
    db.prepare("UPDATE audit_questions SET question = REPLACE(question, '-', '-')").run();
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
      trail         TEXT,                    -- 'Goes to marcy.d@maplewood.example + AP inbox'
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
    /* ---------- schedule mirror: ServiceTrade appointments + assigned techs ----------
     * Powers the live crew-week grid. Synced from /appointment (scheduled, windowed) with the
     * technicians ServiceTrade has assigned. Rebuilt each sync for the current window; read-only. */
    CREATE TABLE IF NOT EXISTS sched_appointments (
      st_id TEXT PRIMARY KEY,
      job_id TEXT, job_number TEXT, job_type TEXT,
      customer TEXT, location_name TEXT, office TEXT,
      window_start TEXT, window_end TEXT, status TEXT,
      st_updated_at TEXT, synced_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sched_window ON sched_appointments(window_start);
    CREATE TABLE IF NOT EXISTS sched_appt_techs (
      appt_st_id TEXT NOT NULL, tech_id TEXT, tech_name TEXT, office TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sched_techs ON sched_appt_techs(appt_st_id);

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
      window TEXT,                    -- '8 to 12'
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
   * The MARGIN IS NEVER STORED - it is computed on read as quoted − cost, so changing a cost
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
   * over its native webhook API - no Zapier. This is a read-side landing table: events are
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
  addColumn('sites', 'source', "TEXT DEFAULT 'seed'"); // 'seed' | 'servicetrade'
  addColumn('crm_jobs', 'source', "TEXT DEFAULT 'seed'");
  addColumn('crm_jobs', 'local_updated_at', 'TEXT');
  addColumn('quotes', 'source', "TEXT DEFAULT 'seed'");

  /* ---------- Google review requests (per-office routing) ----------
   * A completed ServiceTrade job carries assignedOffice (which Northstar branch) and
   * primaryContact (who to ask). We capture both on the job, map each office to its Google
   * review link, and send "how did we do?" so the review lands on the right profile. */
  addColumn('crm_jobs', 'office_id', 'TEXT');
  addColumn('crm_jobs', 'office_name', 'TEXT');
  addColumn('crm_jobs', 'office_phone', 'TEXT');
  addColumn('crm_jobs', 'contact_name', 'TEXT');
  addColumn('crm_jobs', 'contact_email', 'TEXT');
  addColumn('crm_jobs', 'contact_phone', 'TEXT');
  addColumn('crm_jobs', 'review_requested', 'INTEGER DEFAULT 0'); // 1 once a request has been queued/sent
  addColumn('quotes', 'office', 'TEXT'); // the ServiceTrade "Quote Office" (e.g. "Northstar Austin LLC"), for per-location scoping
  db.exec(`
    /* ---------- service-plan mirror: ServiceTrade recurring services (the real agreement book) ----
     * One row per ServiceTrade serviceRecurrence - a location serviced on a cadence. Powers the
     * live Service plans tab. Rebuilt each sync; read-only. */
    CREATE TABLE IF NOT EXISTS service_recurrences (
      st_id        TEXT PRIMARY KEY,
      description  TEXT,
      location_id  TEXT, location_name TEXT, account_id INTEGER,
      service_line TEXT, trade TEXT,
      frequency    TEXT, interval INTEGER, per_year REAL,
      cadence      TEXT,
      price_cents  INTEGER,
      first_start  TEXT, ends_on TEXT,
      office       TEXT,
      st_updated_at TEXT, synced_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_recur_office ON service_recurrences(office);
    CREATE INDEX IF NOT EXISTS idx_recur_ends ON service_recurrences(ends_on);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_targets (
      office_id   TEXT PRIMARY KEY,          -- ServiceTrade assignedOffice id
      office_name TEXT,
      place_id    TEXT,                       -- Google place id (if known)
      review_url  TEXT,                       -- the public "write a review" link the request points to
      phone       TEXT,                       -- office's customer-facing number (overrides ServiceTrade's)
      active      INTEGER DEFAULT 1,          -- 0 pauses requests for this office
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `);
  addColumn('review_targets', 'phone', 'TEXT'); // per-office customer-facing number override
  // review_requests gains routing + delivery columns (was: draft only, off the old jobs fixture).
  addColumn('review_requests', 'office_name', 'TEXT');
  addColumn('review_requests', 'review_url', 'TEXT');
  addColumn('review_requests', 'recipient_email', 'TEXT');
  addColumn('review_requests', 'recipient_phone', 'TEXT');
  addColumn('review_requests', 'subject', 'TEXT');
  addColumn('review_requests', 'html', 'TEXT'); // the rendered HTML body actually sent
  addColumn('review_requests', 'sent_at', 'TEXT');
  addColumn('review_requests', 'error', 'TEXT');
  addColumn('review_requests', 'source', "TEXT DEFAULT 'seed'"); // 'seed' | 'servicetrade'
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_office ON crm_jobs(office_id);`);

  // Indexes for the v2 server-side list query (search / filter / sort / paginate at scale).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_accounts_source  ON accounts(source);
    CREATE INDEX IF NOT EXISTS idx_accounts_name     ON accounts(name);
    CREATE INDEX IF NOT EXISTS idx_accounts_balance  ON accounts(balance_cents);
    CREATE INDEX IF NOT EXISTS idx_accounts_risk     ON accounts(risk);
    CREATE INDEX IF NOT EXISTS idx_sites_account      ON sites(account_id);
    CREATE INDEX IF NOT EXISTS idx_sites_source       ON sites(source);
    CREATE INDEX IF NOT EXISTS idx_sites_name         ON sites(name);
    CREATE INDEX IF NOT EXISTS idx_jobs_source        ON crm_jobs(source);
    CREATE INDEX IF NOT EXISTS idx_jobs_account        ON crm_jobs(account_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_scheduled      ON crm_jobs(scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_quotes_source       ON quotes(source);
    CREATE INDEX IF NOT EXISTS idx_quotes_account       ON quotes(account_id);
    CREATE INDEX IF NOT EXISTS idx_quotes_amount        ON quotes(amount_cents);
  `);

  // Sites pulled before the source column existed defaulted to 'seed'. Tag any site whose
  // parent account came from ServiceTrade as 'servicetrade', so the Sites screen sees the
  // already-pulled 6k+ records without a manual re-pull. Idempotent, flag-guarded; a no-op on
  // a fresh demo database (no ServiceTrade accounts yet).
  if (getState('mig_sites_source_v1') !== '1') {
    db.prepare(
      `UPDATE sites SET source = 'servicetrade'
        WHERE source = 'seed' AND account_id IN (SELECT id FROM accounts WHERE source = 'servicetrade')`
    ).run();
    setState('mig_sites_source_v1', '1');
  }

  /* ---------- People / Employee Lifecycle (onboarding -> active -> offboarding) ----------
   * The employee record is the permanent object; onboarding and offboarding are workflows
   * attached to it. Access/assets/credentials record what a person ACTUALLY has, so
   * offboarding can reverse the real footprint (not just the role-template guess). Sensitive
   * comp data lives on the workflow intake (HR-gated), never broadcast. See server/src/people/.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_users (
      email        TEXT PRIMARY KEY,            -- lowercase; matched to the Entra sign-in email
      display_name TEXT,
      roles        TEXT DEFAULT '',             -- csv of app roles (people_admin,hr,it,safety,accounting,executive_approver,manager,viewer)
      active       INTEGER DEFAULT 1,
      source       TEXT DEFAULT 'admin',
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS employees (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number       TEXT,
      bamboo_id             TEXT,
      legal_first_name      TEXT,
      legal_last_name       TEXT,
      preferred_name        TEXT,
      personal_email        TEXT,
      work_email            TEXT,
      personal_phone        TEXT,
      office                TEXT,
      department            TEXT,
      job_position          TEXT,
      public_job_title      TEXT,
      manager               TEXT,
      employment_type       TEXT,               -- full_time|part_time|contractor
      employment_status     TEXT DEFAULT 'prehire', -- prehire|onboarding|active|notice|offboarding|terminated
      anticipated_start_date TEXT,
      actual_start_date     TEXT,
      notice_date           TEXT,
      last_working_date     TEXT,
      termination_date      TEXT,
      termination_type      TEXT,               -- voluntary|involuntary|immediate
      ad_username           TEXT,
      upn                   TEXT,
      entra_object_id       TEXT,
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(employment_status);
    CREATE INDEX IF NOT EXISTS idx_employees_office ON employees(office);
    CREATE INDEX IF NOT EXISTS idx_employees_position ON employees(job_position);

    CREATE TABLE IF NOT EXISTS employee_access (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id   INTEGER NOT NULL,
      system        TEXT NOT NULL,              -- catalog key or namespaced (sharepoint:mgmt, building:key_fob, vendor:x)
      label         TEXT,
      access_level  TEXT,
      status        TEXT DEFAULT 'requested',   -- requested|awaiting_approval|approved|provisioned|revoked
      owner         TEXT,                        -- owning team
      approver      TEXT,                        -- approver group when gated
      external_ref  TEXT,
      requested_at  TEXT DEFAULT (datetime('now')),
      approved_at   TEXT,
      provisioned_at TEXT,
      revoked_at    TEXT,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_emp_access_emp ON employee_access(employee_id);
    CREATE INDEX IF NOT EXISTS idx_emp_access_status ON employee_access(status);

    CREATE TABLE IF NOT EXISTS employee_assets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id   INTEGER,
      asset_type    TEXT NOT NULL,              -- catalog key (laptop, vehicle, wex_card, key_fob, ...)
      identifier    TEXT,                        -- asset tag / plate / last-4
      serial        TEXT,
      device_name   TEXT,
      status        TEXT DEFAULT 'assigned',    -- available|assigned|pending_return|returned|transferred|missing|damaged|retired
      owner         TEXT,                        -- owning team
      assigned_at   TEXT,
      returned_at   TEXT,
      condition     TEXT,
      received_by   TEXT,
      notes         TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emp_assets_emp ON employee_assets(employee_id);
    CREATE INDEX IF NOT EXISTS idx_emp_assets_status ON employee_assets(status);

    -- Paid software the company assigns to people (Adobe, Bluebeam, HydraCAD, ...). Some vendors have
    -- an API; many do not, so membership is kept current by uploading the vendor's user export (CSV).
    CREATE TABLE IF NOT EXISTS software_apps (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      vendor        TEXT,
      has_api       INTEGER DEFAULT 0,
      seats_paid    INTEGER,
      cost_per_seat REAL,
      active        INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS employee_software (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id   INTEGER NOT NULL,
      app_id        INTEGER NOT NULL,
      status        TEXT DEFAULT 'active',        -- active|removed
      source        TEXT DEFAULT 'csv',           -- csv|api|manual
      external_ref  TEXT,                          -- the login/email seen in the vendor export
      assigned_at   TEXT DEFAULT (datetime('now')),
      removed_at    TEXT,
      notes         TEXT,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      FOREIGN KEY (app_id) REFERENCES software_apps(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_emp_software_uniq ON employee_software(employee_id, app_id);
    CREATE INDEX IF NOT EXISTS idx_emp_software_app ON employee_software(app_id);

    CREATE TABLE IF NOT EXISTS employee_credentials (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id    INTEGER NOT NULL,
      credential_type TEXT NOT NULL,            -- driver_license|proof_of_insurance|osha|nicet|trade_license|...
      status         TEXT DEFAULT 'required',   -- required|uploaded|verified|expired|waived
      uploaded_at    TEXT,
      verified_at    TEXT,
      verified_by    TEXT,
      expires_at     TEXT,
      reminder_at    TEXT,
      notes          TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_emp_cred_emp ON employee_credentials(employee_id);

    CREATE TABLE IF NOT EXISTS people_workflows (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id    INTEGER NOT NULL,
      kind           TEXT NOT NULL,             -- onboarding|offboarding
      status         TEXT DEFAULT 'open',       -- open|complete|canceled
      initiated_by   TEXT,
      manager        TEXT,
      intake_json    TEXT DEFAULT '{}',         -- the manager intake (comp fields are HR-gated on read)
      notice_date    TEXT,
      last_working_date TEXT,
      termination_type TEXT,
      access_cutoff_at TEXT,
      notes          TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      completed_at   TEXT,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pwf_emp ON people_workflows(employee_id);
    CREATE INDEX IF NOT EXISTS idx_pwf_kind_status ON people_workflows(kind, status);

    CREATE TABLE IF NOT EXISTS people_tasks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id    INTEGER NOT NULL,
      employee_id    INTEGER NOT NULL,
      category       TEXT,                       -- identity|hardware|software|access|hr|safety|credentials|sharepoint
      team           TEXT NOT NULL,             -- it|hr|safety|accounting|executive
      kind           TEXT NOT NULL,             -- task|approval
      title          TEXT NOT NULL,
      detail         TEXT,
      status         TEXT DEFAULT 'pending',    -- blocked|pending|awaiting_approval|approved|ready|in_progress|completed|rejected|waived|failed
      item_key       TEXT,                       -- stable key from the routing engine (for dependencies)
      depends_on_key TEXT,                        -- gate: not actionable until this item_key is satisfied
      approver_role  TEXT,                        -- for approvals: the role that can decide
      system         TEXT,
      asset_type     TEXT,
      due_date       TEXT,
      assigned_user  TEXT,
      decided_by     TEXT,
      completed_by   TEXT,
      completed_at   TEXT,
      external_ref   TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workflow_id) REFERENCES people_workflows(id) ON DELETE CASCADE,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ptasks_wf ON people_tasks(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_ptasks_emp ON people_tasks(employee_id);
    CREATE INDEX IF NOT EXISTS idx_ptasks_team_status ON people_tasks(team, status);

    CREATE TABLE IF NOT EXISTS people_audit (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id  INTEGER,
      workflow_id  INTEGER,
      actor        TEXT,
      action       TEXT NOT NULL,
      detail       TEXT,
      at           TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_paudit_emp ON people_audit(employee_id);

    /* config catalogs (seeded from code defaults, extendable by a people_admin) */
    CREATE TABLE IF NOT EXISTS job_positions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE NOT NULL,
      active     INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS role_templates (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      position      TEXT UNIQUE NOT NULL,
      review_status TEXT DEFAULT 'unreviewed',   -- unreviewed|reviewed
      defaults_json TEXT DEFAULT '{}',           -- the default onboarding package (keys into the catalogs)
      updated_by    TEXT,
      updated_at    TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vendor_portals (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT UNIQUE NOT NULL,
      name       TEXT NOT NULL,
      owner      TEXT DEFAULT 'it',
      active     INTEGER DEFAULT 1,
      source     TEXT DEFAULT 'admin',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // employees gains a source marker (manual|bamboo) and a unique Bamboo id for idempotent import.
  addColumn('employees', 'source', "TEXT DEFAULT 'manual'");
  // The authoritative display name from Microsoft 365 (Entra), set by the identity match. Preferred
  // over the BambooHR nickname wherever a person's name is shown.
  addColumn('employees', 'entra_display_name', 'TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_bamboo ON employees(bamboo_id) WHERE bamboo_id IS NOT NULL;`);

  // OS office scope (Phase 1): an app user is authorized for a set of offices (CSV of canonical
  // office keys) OR company-wide (all_offices=1). Office scope is separate from role - a user can
  // have company-wide IT access without company-wide financial access. Enforced server-side.
  addColumn('app_users', 'offices', 'TEXT');            // CSV of canonical office keys; null/'' = none
  addColumn('app_users', 'all_offices', 'INTEGER DEFAULT 0'); // 1 = company-wide scope

  // Deficiency disposition (Phase D): why an open, unquoted deficiency is not being converted, so the
  // backlog is worked deliberately (needs_review|customer_declined|duplicate|warranty|waiting_information|quote_in_progress).
  addColumn('deficiencies', 'disposition', 'TEXT');
  addColumn('deficiencies', 'disposition_note', 'TEXT');
  addColumn('deficiencies', 'disposition_by', 'TEXT');
  addColumn('deficiencies', 'disposition_at', 'TEXT');

  // Saved reports (Phase 2): a stored report *definition*, not a snapshot. Reopened, it reruns
  // against current data UNDER THE VIEWING USER'S authorization (scope is re-resolved at run time).
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_email TEXT NOT NULL,
      name        TEXT NOT NULL,
      config_json TEXT NOT NULL,      -- {metric, office, period, groupBy, viz, ...}
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_saved_reports_owner ON saved_reports(owner_email);
  `);
  // saved-report scheduling: deliver a saved report by email on a cadence (weekly today).
  addColumn('saved_reports', 'schedule', "TEXT DEFAULT 'none'");   // none | weekly
  addColumn('saved_reports', 'recipient', 'TEXT');                 // email to deliver to
  addColumn('saved_reports', 'last_sent_at', 'TEXT');
  addColumn('saved_reports', 'next_run_at', 'TEXT');               // when the next delivery is due

  // Editable onboarding form catalog: the computers, software, SharePoint groups, and printers the
  // onboarding form offers. Kept in the database (not hardcoded) so a People admin maintains the real
  // company list. `kind` is computer|software|sharepoint|printer. `owner` + `approval` drive routing
  // (which team the item goes to, and whether it needs a yes). `spec` is the computer description.
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_catalog (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      kind     TEXT NOT NULL,                 -- computer | software | sharepoint | printer
      name     TEXT NOT NULL,                 -- display name (Standard, Bluebeam, Austin, ...)
      spec     TEXT,                          -- computers: the spec/description line
      owner    TEXT DEFAULT 'it',             -- routing owner (it|mario|rebecca|sandi|denise|daniel)
      approval INTEGER DEFAULT 0,             -- 1 = needs an approval before it is granted
      sort     INTEGER DEFAULT 0,
      active   INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_onboarding_catalog_kind ON onboarding_catalog(kind, active, sort);
  `);
  // Access items (printers, and later SharePoint) map to an Entra security group: selecting one adds
  // the hire to that group, auto-provisioned through Microsoft Graph when connected. Added by
  // ALTER so existing databases pick them up.
  addColumn('onboarding_catalog', 'group_name', 'TEXT'); // e.g. SG-PR-MCA
  addColumn('onboarding_catalog', 'group_id', 'TEXT');   // the Entra group object id (GUID)

  // Per-integration sync cadence. One row per syncing integration (servicetrade|bamboo|microsoft|
  // calls). interval_minutes is how often it auto-syncs (0 or enabled=0 means paused). The scheduler
  // runs an integration when now - last_run_at >= its interval. Defaults are seeded in code, so an
  // absent row falls back to the built-in cadence.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_schedules (
      integration_key  TEXT PRIMARY KEY,
      interval_minutes INTEGER NOT NULL,
      enabled          INTEGER NOT NULL DEFAULT 1,
      last_run_at      TEXT,
      last_status      TEXT,                       -- ok | error | never
      last_detail      TEXT,
      updated_at       TEXT DEFAULT (datetime('now'))
    );
  `);

  // Exceptions (Phase 3): the generic "reality does not match the intended process" object. One
  // table for every department (accounting/ops/people/it/fleet), deduped by a stable key so the
  // detector is idempotent. office holds a canonical office key (or null for company-wide) so
  // exceptions scope exactly like every other object.
  db.exec(`
    CREATE TABLE IF NOT EXISTS exceptions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key     TEXT UNIQUE,               -- stable key -> idempotent detection
      category       TEXT NOT NULL,             -- e.g. deficiency_aging, terminated_access, ar_aging
      source_system  TEXT,                      -- servicetrade|bamboo|microsoft|invoices|derived
      office         TEXT,                      -- canonical office key, or NULL for company-wide
      subject_type   TEXT,                      -- office|employee|job|invoice|company
      subject_id     TEXT,
      title          TEXT NOT NULL,
      description    TEXT,
      severity       TEXT DEFAULT 'medium',     -- low|medium|high|critical
      financial_impact INTEGER DEFAULT 0,       -- whole USD; 0 when not quantified
      financial_projected INTEGER DEFAULT 0,    -- 1 = the impact is an estimate, not booked
      owner_team     TEXT,                       -- accounting|operations|people|it|safety
      assigned_user  TEXT,
      status         TEXT DEFAULT 'open',        -- open|assigned|in_progress|resolved|dismissed|ignored|blocked
      count          INTEGER DEFAULT 1,          -- how many underlying records this rolls up
      detected_at    TEXT DEFAULT (datetime('now')),
      due_at         TEXT,
      resolved_at    TEXT,
      resolution     TEXT,
      evidence_json  TEXT,
      updated_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_exceptions_status ON exceptions(status);
    CREATE INDEX IF NOT EXISTS idx_exceptions_office ON exceptions(office);
    CREATE INDEX IF NOT EXISTS idx_exceptions_owner ON exceptions(owner_team);
  `);
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
