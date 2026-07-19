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
