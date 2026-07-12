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

  /* ---------- migrations: invoice reminder workflow (ServiceTrade + Resend/Telnyx) ----------
   * Reminders fire on a day-1/3/5/7 cadence measured from job completion, not the due date.
   * Added as idempotent migrations so existing brains upgrade in place. */
  addColumn('invoices', 'servicetrade_id', 'TEXT');       // ServiceTrade invoice id (idempotency key)
  addColumn('invoices', 'servicetrade_job_id', 'TEXT');   // the completed job that produced it
  addColumn('invoices', 'job_completed_at', 'TEXT');       // completion date → drives the cadence
  addColumn('invoices', 'auto_remind', 'INTEGER DEFAULT 1'); // 1 = enrolled in the auto sequence

  // One ServiceTrade invoice = one row. NULL ids may repeat (seed/manual rows).
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_st_id
       ON invoices(servicetrade_id) WHERE servicetrade_id IS NOT NULL;`
  );

  // invoice_reminders gains the sequence/channel/delivery columns.
  addColumn('invoice_reminders', 'channel', "TEXT DEFAULT 'email'"); // email|sms
  addColumn('invoice_reminders', 'step', 'INTEGER DEFAULT 0');       // day offset (1,3,5,7); 0 = manual nudge
  addColumn('invoice_reminders', 'scheduled_for', 'TEXT');           // date this step is due (YYYY-MM-DD)
  addColumn('invoice_reminders', 'sent_at', 'TEXT');                 // delivery timestamp
  addColumn('invoice_reminders', 'provider', 'TEXT');               // resend|telnyx|none
  addColumn('invoice_reminders', 'provider_id', 'TEXT');            // provider message id
  addColumn('invoice_reminders', 'error', 'TEXT');                  // last send error, if any

  // status vocabulary: scheduled|queued|sent|failed|skipped|draft|approved.
  // One row per (invoice, step, channel) so the sweep never double-schedules.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_step
       ON invoice_reminders(invoice_id, step, channel) WHERE step > 0;`
  );
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
