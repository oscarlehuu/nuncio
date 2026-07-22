import { Global, Injectable, OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { ensureCrewSchema } from '../crew/persistence/crew-schema';

const DATABASE_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  provider TEXT NOT NULL DEFAULT 'pi',
  model TEXT,
  mode TEXT,
  workspace TEXT,
  prompt TEXT NOT NULL,
  preview TEXT,
  project_path TEXT,
  base_branch TEXT,
  worktree_path TEXT,
  branch TEXT,
  provider_thread_id TEXT,
  provider_active_turn_id TEXT,
  provider_state_json TEXT,
  runtime_policy_json TEXT,
  verify_owner TEXT NOT NULL DEFAULT 'session',
  forge_provider TEXT,
  pull_request_url TEXT,
  pull_request_number INTEGER,
  pull_request_state TEXT,
  forge_status TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, seq),
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_observability_window
ON events(session_id, type, created_at, seq)
WHERE type IN (
  'status', 'user_message', 'steer_message', 'steer_queued',
  'verify_result', 'verify_needs_attention'
);

CREATE TABLE IF NOT EXISTS provider_requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  method TEXT NOT NULL,
  params_json TEXT,
  status TEXT NOT NULL,
  decision TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_provider_requests_session_status
ON provider_requests(session_id, status);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT,
  secret_hash TEXT NOT NULL,
  prev_secret_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
`;

@Global()
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db: Database;
  /** Resolved data directory (exposed so other services can colocate files, e.g. the settings key). */
  readonly dataDir: string;
  /**
   * True once the connection is being/has been torn down. Repositories consult
   * this to no-op instead of touching a closed handle: an in-flight agent turn
   * can outlive shutdown (a provider that ignores abort past the bounded drain)
   * and its continuation would otherwise write after close (SQLITE_MISUSE/IOERR).
   */
  private _closed = false;
  private readonly scheduleDispatchIntentStack: string[] = [];

  get closed(): boolean {
    return this._closed;
  }

  /** Current durable scheduler intent while its target rows are committed. */
  get currentScheduleDispatchIntentId(): string | null {
    return this.scheduleDispatchIntentStack.at(-1) ?? null;
  }

  /**
   * Correlate the synchronous task/run inserts performed by one target invocation.
   * A stack handles re-entrant fires without leaking the receipt into the task's
   * later async execution, which starts only after target creation returns.
   */
  withScheduleDispatchIntent<T>(intentId: string, createTarget: () => T): T {
    this.scheduleDispatchIntentStack.push(intentId);
    try {
      return createTarget();
    } finally {
      this.scheduleDispatchIntentStack.pop();
    }
  }

  constructor() {
    const dataDir = process.env.NUNCIO_DATA_DIR ?? join(process.cwd(), 'data');
    mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.db = new Database(join(dataDir, 'nuncio.db'));
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    try {
      this.runMigrations();
    } catch (error) {
      this._closed = true;
      this.db.close();
      throw error;
    }
  }

  onModuleDestroy() {
    this._closed = true;
    this.db.close();
  }

  /**
   * Run `fn` inside a single SQLite transaction: it commits if `fn` returns and
   * rolls back every write if `fn` throws. Use for multi-statement invariants
   * that must be all-or-nothing (e.g. batch inserts plus a queue delete).
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  immediateTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  /**
   * SQLite's BEGIN IMMEDIATE write lock serializes every boot's schema work.
   * All guarded column/index checks therefore run after ownership is acquired,
   * and user_version advances only with the same atomic commit.
   */
  private runMigrations(): void {
    this.db.transaction(() => {
      const row = this.db.prepare<{ user_version: number }, []>('PRAGMA user_version').get();
      const currentVersion = row?.user_version ?? 0;
      this.db.exec(SCHEMA);
      this.migrate();
      ensureCrewSchema(this);
      if (currentVersion < DATABASE_SCHEMA_VERSION) {
        this.db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      }
    }).immediate();
  }

  private migrate(): void {
    const sessionColumns = this.db
      .prepare('PRAGMA table_info(sessions)')
      .all() as Array<{ name: string }>;

    if (!sessionColumns.some((column) => column.name === 'provider')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'pi'");
    }

    if (!sessionColumns.some((column) => column.name === 'workspace')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN workspace TEXT');
    }

    const workspaceColumns = [
      'project_path',
      'base_branch',
      'worktree_path',
      'branch',
    ] as const;

    for (const column of workspaceColumns) {
      if (!sessionColumns.some((entry) => entry.name === column)) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
      }
    }

    if (!sessionColumns.some((column) => column.name === 'model_options')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN model_options TEXT');
    }

    if (!sessionColumns.some((column) => column.name === 'mode')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN mode TEXT');
    }

    if (!sessionColumns.some((column) => column.name === 'cursor_backend')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN cursor_backend TEXT');
    }

    if (!sessionColumns.some((column) => column.name === 'cursor_chat_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN cursor_chat_id TEXT');
    }

    const providerRuntimeColumns = [
      'provider_thread_id',
      'provider_active_turn_id',
      'provider_state_json',
    ] as const;

    for (const column of providerRuntimeColumns) {
      if (!sessionColumns.some((entry) => entry.name === column)) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
      }
    }

    if (!sessionColumns.some((column) => column.name === 'runtime_policy_json')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN runtime_policy_json TEXT');
    }

    if (!sessionColumns.some((column) => column.name === 'mcp_server_ids_json')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN mcp_server_ids_json TEXT');
    }

    if (!sessionColumns.some((column) => column.name === 'verify_owner')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN verify_owner TEXT NOT NULL DEFAULT 'session'");
    }

    // Session lineage: tree parentage (parent_session_id / origin_task_id) and
    // linear handoff chains (prior_session_id, e.g. a mobile-continued session).
    const lineageColumns = ['parent_session_id', 'origin_task_id', 'prior_session_id'] as const;
    for (const column of lineageColumns) {
      if (!sessionColumns.some((entry) => entry.name === column)) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)');

    const forgeColumns = [
      ['forge_provider', 'TEXT'],
      ['pull_request_url', 'TEXT'],
      ['pull_request_number', 'INTEGER'],
      ['pull_request_state', 'TEXT'],
      ['forge_status', "TEXT NOT NULL DEFAULT 'none'"],
    ] as const;

    for (const [column, type] of forgeColumns) {
      if (!sessionColumns.some((entry) => entry.name === column)) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${type}`);
      }
    }

    // Webhook routing historically selected the newest owner, so preserve that
    // winner while detaching older duplicates before enforcing the invariant.
    this.db.exec(`
      UPDATE sessions AS older
      SET forge_provider = NULL, pull_request_url = NULL,
          pull_request_number = NULL, pull_request_state = NULL,
          forge_status = 'none'
      WHERE older.project_path IS NOT NULL
        AND older.pull_request_number IS NOT NULL
        AND older.status != 'ARCHIVED'
        AND older.verify_owner = 'session'
        AND EXISTS (
          SELECT 1 FROM sessions AS newer
          WHERE newer.project_path = older.project_path
            AND newer.pull_request_number = older.pull_request_number
            AND newer.status != 'ARCHIVED'
            AND newer.verify_owner = 'session'
            AND (
              newer.updated_at > older.updated_at
              OR (newer.updated_at = older.updated_at AND newer.rowid > older.rowid)
            )
        )
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_project_pr_unique
      ON sessions(project_path, pull_request_number)
      WHERE project_path IS NOT NULL AND pull_request_number IS NOT NULL
        AND status != 'ARCHIVED' AND verify_owner = 'session'
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_cli_chat_unique
      ON sessions(cursor_chat_id) WHERE cursor_backend = 'cli'
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        method TEXT NOT NULL,
        params_json TEXT,
        status TEXT NOT NULL,
        decision TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_provider_requests_session_status
      ON provider_requests(session_id, status)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS forge_webhook_deliveries (
        provider TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        claim_token TEXT,
        lease_expires_at INTEGER,
        updated_at INTEGER,
        checkpoint TEXT,
        accepted_session_id TEXT,
        PRIMARY KEY (provider, delivery_id)
      )
    `);
    const forgeDeliveryColumns = this.db
      .prepare('PRAGMA table_info(forge_webhook_deliveries)')
      .all() as Array<{ name: string }>;
    const deliveryColumns = [
      ['status', "TEXT NOT NULL DEFAULT 'completed'"],
      ['claim_token', 'TEXT'],
      ['lease_expires_at', 'INTEGER'],
      ['updated_at', 'INTEGER'],
      ['checkpoint', 'TEXT'],
      ['accepted_session_id', 'TEXT'],
    ] as const;
    for (const [column, type] of deliveryColumns) {
      if (!forgeDeliveryColumns.some((entry) => entry.name === column)) {
        this.db.exec(`ALTER TABLE forge_webhook_deliveries ADD COLUMN ${column} ${type}`);
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS forge_pr_session_claims (
        project_path TEXT NOT NULL,
        pull_request_number INTEGER NOT NULL,
        claim_token TEXT NOT NULL,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        PRIMARY KEY (project_path, pull_request_number)
      )
    `);
    const forgeClaimColumns = this.db
      .prepare('PRAGMA table_info(forge_pr_session_claims)')
      .all() as Array<{ name: string }>;
    if (!forgeClaimColumns.some((column) => column.name === 'lease_expires_at')) {
      this.db.exec('ALTER TABLE forge_pr_session_claims ADD COLUMN lease_expires_at INTEGER');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recent_projects (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_used_at INTEGER NOT NULL
      )
    `);

    // Per-project CONFIG entity (rung 2). Keyed by normalized path; distinct from
    // recent_projects (the MRU picker). project_path on sessions/tasks is a SOFT
    // reference into this table — no FK, so an unconfigured path is valid.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        default_engine TEXT,
        worktree_policy TEXT,
        verify_command TEXT,
        verify_auto_steer TEXT NOT NULL DEFAULT 'inherit',
        verify_max_rounds INTEGER,
        weight INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Scheduler (rung 2 sub-phase B): durable cron/event/heartbeat triggers.
    // next_fire_at is recomputed from spec + clock at boot (never in-memory truth).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        spec TEXT NOT NULL,
        target_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_fire_at INTEGER,
        last_fire_at INTEGER,
        last_result TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const scheduleColumns = this.db
      .prepare('PRAGMA table_info(schedules)')
      .all() as Array<{ name: string }>;
    if (!scheduleColumns.some((column) => column.name === 'generation')) {
      this.db.exec('ALTER TABLE schedules ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_dispatch_intents (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        fired_at INTEGER NOT NULL,
        initial_result TEXT NOT NULL,
        next_fire_at INTEGER,
        target_json TEXT NOT NULL,
        trigger_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        claim_token TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const dispatchIntentColumns = this.db
      .prepare('PRAGMA table_info(schedule_dispatch_intents)')
      .all() as Array<{ name: string }>;
    if (!dispatchIntentColumns.some((column) => column.name === 'claim_token')) {
      this.db.exec('ALTER TABLE schedule_dispatch_intents ADD COLUMN claim_token TEXT');
    }
    if (!dispatchIntentColumns.some((column) => column.name === 'lease_expires_at')) {
      this.db.exec('ALTER TABLE schedule_dispatch_intents ADD COLUMN lease_expires_at INTEGER');
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schedule_dispatch_intents_pending
      ON schedule_dispatch_intents(status, created_at)
    `);

    // Loop primitive (rung 2 sub-phase C): standing tasks. A loop OWNS its
    // schedule_id; budgets/breaker/stop are folded from loop_runs (restart-safe,
    // no in-memory counters). Run history is KEPT on delete (founder-locked).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS loops (
        id TEXT PRIMARY KEY,
        name TEXT,
        goal TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        max_runs_per_day INTEGER NOT NULL,
        max_consecutive_failures INTEGER NOT NULL,
        stop_json TEXT,
        escalation TEXT NOT NULL,
        project_path TEXT,
        engine TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    // v1.1+ additive columns — guarded ALTERs for pre-existing loops tables.
    const loopColumns = this.db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>;
    if (!loopColumns.some((c) => c.name === 'engine')) {
      this.db.exec('ALTER TABLE loops ADD COLUMN engine TEXT');
    }
    if (!loopColumns.some((c) => c.name === 'name')) {
      this.db.exec('ALTER TABLE loops ADD COLUMN name TEXT');
    }
    if (!loopColumns.some((c) => c.name === 'model')) {
      this.db.exec('ALTER TABLE loops ADD COLUMN model TEXT');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL,
        task_id TEXT,
        outcome TEXT NOT NULL,
        verify TEXT NOT NULL DEFAULT 'none',
        day_bucket TEXT NOT NULL,
        schedule_dispatch_intent_id TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    const loopRunColumns = this.db
      .prepare('PRAGMA table_info(loop_runs)')
      .all() as Array<{ name: string }>;
    if (!loopRunColumns.some((column) => column.name === 'schedule_dispatch_intent_id')) {
      this.db.exec('ALTER TABLE loop_runs ADD COLUMN schedule_dispatch_intent_id TEXT');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_loop_runs_loop ON loop_runs(loop_id, created_at)');
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_runs_task ON loop_runs(task_id) WHERE task_id IS NOT NULL',
    );
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_runs_schedule_dispatch_intent
      ON loop_runs(schedule_dispatch_intent_id)
      WHERE schedule_dispatch_intent_id IS NOT NULL
    `);

    // Attention queue (rung 3, sub-phase A). ONE ranked queue of everything needing
    // the founder. Deduped: a partial UNIQUE index over open rows guarantees at most
    // one OPEN item per (kind, subject_id); resolved rows never block a re-trip.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attention_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        project_path TEXT,
        severity INTEGER NOT NULL,
        title TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        acknowledged_at INTEGER,
        suppress_reraise INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      )
    `);
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_open_dedup
         ON attention_items(kind, subject_id) WHERE status = 'open'`,
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_attention_status ON attention_items(status, severity)',
    );
    // A manual resolve of a still-live condition sets suppress_reraise=1 so a
    // periodic sweep does not re-raise the founder's override; the sweep clears it
    // back to 0 once the underlying condition is observed CLEAR, so a genuine
    // re-trip legitimately produces a fresh item. Guarded ALTER for older DBs.
    const attentionColumns = this.db.prepare('PRAGMA table_info(attention_items)').all() as Array<{ name: string }>;
    if (!attentionColumns.some((c) => c.name === 'suppress_reraise')) {
      this.db.exec('ALTER TABLE attention_items ADD COLUMN suppress_reraise INTEGER NOT NULL DEFAULT 0');
    }

    // Heartbeat digest markers (rung 3 sub-phase B). One row per SENT digest slot
    // — the durable record behind not-double-sent-on-catch-up + the since-last
    // window + the in-app read. slot_key = '<YYYY-MM-DD>:<morning|evening>'.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS digest_runs (
        slot_key TEXT PRIMARY KEY,
        variant TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        window_from INTEGER NOT NULL,
        window_to INTEGER NOT NULL,
        summary_json TEXT NOT NULL
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_digest_runs_sent ON digest_runs(sent_at DESC)');

    // Heartbeat health (rung 3 sub-phase B). One row per system job — the durable
    // last-run timestamp + outcome so a swallowed layer failure surfaces in the
    // Settings health block instead of vanishing. Read-only observability.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS heartbeat_health (
        job TEXT PRIMARY KEY,
        last_run_at INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT,
        updated_at INTEGER NOT NULL
      )
    `);

    // Per-project importance weight (rung 3 ranking + fleet home). Guarded ALTER on
    // a pre-existing projects table; default 1 (equal importance) applied by the repo.
    const projectColumns = this.db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    if (projectColumns.length > 0 && !projectColumns.some((c) => c.name === 'weight')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN weight INTEGER');
    }
    if (projectColumns.length > 0 && !projectColumns.some((c) => c.name === 'mcp_server_ids_json')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN mcp_server_ids_json TEXT');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'QUEUED',
        provider TEXT,
        model TEXT,
        model_options TEXT,
        project_path TEXT,
        base_branch TEXT,
        use_worktree INTEGER NOT NULL DEFAULT 0,
        workspace TEXT,
        parent_session_id TEXT,
        role TEXT NOT NULL DEFAULT 'standalone',
        cleanup_policy TEXT,
        review_state TEXT,
        session_id TEXT,
        outcome_json TEXT,
        hold_until INTEGER,
        crew_run_id TEXT,
        crew_member_key TEXT,
        crew_phase TEXT,
        crew_attempt_key TEXT,
        execution_kind TEXT NOT NULL DEFAULT 'session',
        runtime_policy_json TEXT,
        verify_owner TEXT NOT NULL DEFAULT 'session',
        schedule_dispatch_intent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created
      ON tasks(status, created_at)
    `);

    const taskColumns = this.db
      .prepare('PRAGMA table_info(tasks)')
      .all() as Array<{ name: string }>;

    const taskColumnDefinitions = [
      ['parent_session_id', 'TEXT'],
      ['role', "TEXT NOT NULL DEFAULT 'standalone'"],
      ['cleanup_policy', 'TEXT'],
      ['review_state', 'TEXT'],
      ['hold_until', 'INTEGER'],
      ['context_json', 'TEXT'],
      ['notify_policy', 'TEXT'],
      ['tag', 'TEXT'],
      ['crew_run_id', 'TEXT'],
      ['crew_member_key', 'TEXT'],
      ['crew_phase', 'TEXT'],
      ['crew_attempt_key', 'TEXT'],
      ['execution_kind', "TEXT NOT NULL DEFAULT 'session'"],
      ['runtime_policy_json', 'TEXT'],
      ['verify_owner', "TEXT NOT NULL DEFAULT 'session'"],
      ['schedule_dispatch_intent_id', 'TEXT'],
    ] as const;

    for (const [column, type] of taskColumnDefinitions) {
      if (!taskColumns.some((entry) => entry.name === column)) {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_parent_session
      ON tasks(parent_session_id, created_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_crew_run
      ON tasks(crew_run_id, created_at)
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_schedule_dispatch_intent
      ON tasks(schedule_dispatch_intent_id)
      WHERE schedule_dispatch_intent_id IS NOT NULL
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_reconciliation_outbox (
        task_id TEXT PRIMARY KEY,
        digest_pending INTEGER NOT NULL DEFAULT 1,
        settlement_pending INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_reconciliation_outbox_pending
      ON task_reconciliation_outbox(digest_pending, settlement_pending, created_at)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_approval_correlations (
        correlation_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_approval_correlations_task
      ON task_approval_correlations(task_id)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        token TEXT PRIMARY KEY,
        platform TEXT,
        device_name TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    const pushTokenColumns = this.db
      .prepare('PRAGMA table_info(push_tokens)')
      .all() as Array<{ name: string }>;
    if (!pushTokenColumns.some((column) => column.name === 'device_id')) {
      this.db.exec('ALTER TABLE push_tokens ADD COLUMN device_id TEXT');
    }
    if (!pushTokenColumns.some((column) => column.name === 'notifications_enabled')) {
      this.db.exec(
        'ALTER TABLE push_tokens ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1',
      );
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tokens_device
      ON push_tokens(device_id) WHERE device_id IS NOT NULL
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS steer_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message TEXT NOT NULL,
        attachments_json TEXT,
        failure_context_json TEXT,
        failure_reported_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_steer_queue_session
      ON steer_queue(session_id, id)
    `);

    const steerQueueColumns = this.db
      .prepare('PRAGMA table_info(steer_queue)')
      .all() as Array<{ name: string }>;
    if (!steerQueueColumns.some((column) => column.name === 'claimed_at')) {
      // A non-null claim leases a row to an in-flight multitask fan-out so the
      // normal settle-drain skips it; cleared unconditionally at daemon boot.
      this.db.exec('ALTER TABLE steer_queue ADD COLUMN claimed_at INTEGER');
    }
    if (!steerQueueColumns.some((column) => column.name === 'origin')) {
      // Provenance carried to the delivered steer_message (e.g. 'task-digest')
      // so the auto-steer rate cap can count queued-then-drained wakes.
      this.db.exec('ALTER TABLE steer_queue ADD COLUMN origin TEXT');
    }
    if (!steerQueueColumns.some((column) => column.name === 'failure_context_json')) {
      this.db.exec('ALTER TABLE steer_queue ADD COLUMN failure_context_json TEXT');
    }
    if (!steerQueueColumns.some((column) => column.name === 'failure_reported_at')) {
      this.db.exec('ALTER TABLE steer_queue ADD COLUMN failure_reported_at INTEGER');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Durable, per-project curated facts every engine can read. No expires_at —
    // facts are curated, not cached; staleness is handled by founder deletion.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_facts (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        provenance TEXT NOT NULL,
        source_session_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_path, key)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_context_facts_project
      ON context_facts(project_path, updated_at)
    `);

    // MCP Store (inbound): external MCP servers registered with Nuncio and
    // bridged to engine sessions. transport_json holds the canonical transport
    // with secret env/header values encrypted in place (settings AES key).
    // identity is the transport dedupe key; the unique index treats a NULL
    // project_path (global scope) as the '' bucket.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        transport_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        advertise TEXT NOT NULL DEFAULT 'lazy',
        project_path TEXT,
        engines_json TEXT,
        auth TEXT NOT NULL DEFAULT 'none',
        sources_json TEXT NOT NULL DEFAULT '[]',
        secret_keys_json TEXT NOT NULL DEFAULT '[]',
        identity TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_identity_scope
      ON mcp_servers(identity, ifnull(project_path, ''))
    `);

    // OAuth tokens for remote MCP servers (encrypted with the settings AES key).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth (
        server_id TEXT PRIMARY KEY,
        tokens_json TEXT,
        client_info_json TEXT,
        code_verifier TEXT,
        state TEXT,
        redirect_uri TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_state ON mcp_oauth(state)
    `);

    // Agent-proposed changes to a founder fact land here for founder review.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_fact_proposals (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        key TEXT NOT NULL,
        proposed_value TEXT NOT NULL,
        source_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_context_fact_proposals_project
      ON context_fact_proposals(project_path, status)
    `);
  }
}
