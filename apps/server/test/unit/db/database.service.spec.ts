import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../../../src/db/database.service';

// bun:sqlite (Bun builtin) — used to seed a pre-migration schema on disk.
const { Database } = require('bun:sqlite');

describe('DatabaseService schema + migration', () => {
  let db: DatabaseService | undefined;
  let dataDir: string;

  afterEach(() => {
    db?.onModuleDestroy();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('creates the partial observability fact index without indexing transcript noise', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-observability-index-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();
    const index = db.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_events_observability_window') as { sql: string } | null;

    expect(index?.sql).toContain('session_id, type, created_at, seq');
    expect(index?.sql).toContain("'verify_needs_attention'");
    expect(index?.sql).not.toContain('assistant_delta');
    expect(index?.sql).not.toContain('tool_end');
  });

  it('fresh schema includes a provider column on sessions', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-fresh-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();
    const cols = db.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    expect(cols.map((column) => column.name)).toContain('provider');
    expect(cols.map((column) => column.name)).toContain('model_options');
    expect(cols.map((column) => column.name)).toContain('provider_thread_id');
    expect(cols.map((column) => column.name)).toContain('provider_active_turn_id');
    expect(cols.map((column) => column.name)).toContain('provider_state_json');
    expect(cols.map((column) => column.name)).toContain('runtime_policy_json');
    expect(cols.map((column) => column.name)).toContain('verify_owner');
  });

  it('fresh schema includes provider request persistence', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-provider-requests-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const cols = db.db.prepare('PRAGMA table_info(provider_requests)').all() as Array<{
      name: string;
    }>;

    expect(tables.map((table) => table.name)).toContain('provider_requests');
    expect(cols.map((column) => column.name)).toEqual([
      'request_id',
      'session_id',
      'provider',
      'method',
      'params_json',
      'status',
      'decision',
      'reason',
      'created_at',
      'resolved_at',
    ]);
  });

  it('adds durable task execution columns to fresh and existing task rows', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-task-exec-migrate-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    const oldDb = new Database(join(dataDir, 'nuncio.db'));
    oldDb.exec(
      `CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'QUEUED',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    oldDb
      .prepare(
        `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
         VALUES ('existing-task', 'keep task', 'QUEUED', 1, 2)`,
      )
      .run();
    oldDb.close();

    db = new DatabaseService();
    const columns = db.db.prepare('PRAGMA table_info(tasks)').all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['execution_kind', 'runtime_policy_json', 'verify_owner']),
    );
    expect(columns.find((column) => column.name === 'execution_kind')?.dflt_value).toBe("'session'");
    expect(columns.find((column) => column.name === 'verify_owner')?.dflt_value).toBe("'session'");
    const existing = db.db
      .prepare(
        `SELECT prompt, execution_kind, runtime_policy_json, verify_owner
         FROM tasks WHERE id = ?`,
      )
      .get('existing-task') as {
        prompt: string;
        execution_kind: string;
        runtime_policy_json: string | null;
        verify_owner: string;
      };
    expect(existing).toEqual({
      prompt: 'keep task',
      execution_kind: 'session',
      runtime_policy_json: null,
      verify_owner: 'session',
    });
  });

  it('defaults provider to pi when omitted on insert', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-default-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();
    db.db
      .prepare(
        `INSERT INTO sessions (id, title, status, model, prompt, preview, created_at, updated_at)
         VALUES ('t1', 't', 'CREATED', NULL, 'p', NULL, 0, 0)`,
      )
      .run();

    const row = db.db.prepare('SELECT provider FROM sessions WHERE id = ?').get('t1') as {
      provider: string;
    };
    expect(row.provider).toBe('pi');
  });

  it('migrates a pre-existing sessions table by adding provider runtime columns', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-migrate-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    const oldDb = new Database(join(dataDir, 'nuncio.db'));
    oldDb.exec(
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'CREATED',
        model TEXT,
        prompt TEXT NOT NULL,
        preview TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    oldDb
      .prepare(
        `INSERT INTO sessions (id, title, status, model, prompt, preview, created_at, updated_at)
         VALUES ('old', 't', 'IDLE', NULL, 'p', NULL, 0, 0)`,
      )
      .run();
    oldDb.close();

    db = new DatabaseService();

    const cols = db.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    expect(cols.map((column) => column.name)).toContain('provider');
    expect(cols.map((column) => column.name)).toContain('provider_thread_id');
    expect(cols.map((column) => column.name)).toContain('provider_active_turn_id');
    expect(cols.map((column) => column.name)).toContain('provider_state_json');
    expect(cols.map((column) => column.name)).toContain('runtime_policy_json');
    expect(cols.map((column) => column.name)).toContain('verify_owner');

    const row = db.db
      .prepare(
        `SELECT provider, provider_thread_id, provider_active_turn_id, provider_state_json,
                runtime_policy_json, verify_owner
         FROM sessions WHERE id = ?`,
      )
      .get('old') as {
      provider: string;
      provider_thread_id: string | null;
      provider_active_turn_id: string | null;
      provider_state_json: string | null;
      runtime_policy_json: string | null;
      verify_owner: string;
    };
    expect(row.provider).toBe('pi');
    expect(row.provider_thread_id).toBeNull();
    expect(row.provider_active_turn_id).toBeNull();
    expect(row.provider_state_json).toBeNull();
    expect(row.runtime_policy_json).toBeNull();
    expect(row.verify_owner).toBe('session');
  });

  it('migrates a pre-existing loops table by adding the engine + name columns', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-loops-migrate-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    // A loops table from before per-loop engine override + optional name existed.
    const oldDb = new Database(join(dataDir, 'nuncio.db'));
    oldDb.exec(
      `CREATE TABLE loops (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        max_runs_per_day INTEGER NOT NULL,
        max_consecutive_failures INTEGER NOT NULL,
        stop_json TEXT,
        escalation TEXT NOT NULL,
        project_path TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    oldDb
      .prepare(
        `INSERT INTO loops
           (id, goal, schedule_id, max_runs_per_day, max_consecutive_failures,
            stop_json, escalation, project_path, status, created_at, updated_at)
         VALUES ('old', 'g', 's', 5, 3, NULL, 'needs-attention', NULL, 'active', 0, 0)`,
      )
      .run();
    oldDb.close();

    db = new DatabaseService();

    const cols = db.db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>;
    expect(cols.map((column) => column.name)).toContain('engine');
    expect(cols.map((column) => column.name)).toContain('name');

    const row = db.db.prepare('SELECT engine, name FROM loops WHERE id = ?').get('old') as {
      engine: string | null;
      name: string | null;
    };
    expect(row.engine).toBeNull();
    expect(row.name).toBeNull();
  });

  it('migrates a pre-existing loops table by adding the model column', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-loops-model-migrate-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    // A loops table from before per-loop model selection existed (has engine + name).
    const oldDb = new Database(join(dataDir, 'nuncio.db'));
    oldDb.exec(
      `CREATE TABLE loops (
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
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    oldDb
      .prepare(
        `INSERT INTO loops
           (id, name, goal, schedule_id, max_runs_per_day, max_consecutive_failures,
            stop_json, escalation, project_path, engine, status, created_at, updated_at)
         VALUES ('old', NULL, 'g', 's', 5, 3, NULL, 'needs-attention', NULL, NULL, 'active', 0, 0)`,
      )
      .run();
    oldDb.close();

    db = new DatabaseService();

    const cols = db.db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>;
    expect(cols.map((column) => column.name)).toContain('model');

    const row = db.db.prepare('SELECT model FROM loops WHERE id = ?').get('old') as {
      model: string | null;
    };
    expect(row.model).toBeNull();
  });

  it('creates the attention_items table + open-dedup unique index on a fresh DB', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-attention-fresh-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();

    const cols = db.db.prepare('PRAGMA table_info(attention_items)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual([
      'id',
      'kind',
      'subject_id',
      'project_path',
      'severity',
      'title',
      'payload_json',
      'status',
      'acknowledged_at',
      'suppress_reraise',
      'created_at',
      'updated_at',
      'resolved_at',
    ]);

    // The partial UNIQUE index over open rows is what makes dedup DB-enforced: two
    // OPEN rows for the same (kind, subject_id) must be rejected, but a resolved +
    // an open row for the same condition must coexist.
    const now = Date.now();
    const insert = (id: string, status: string) =>
      db!.db
        .prepare(
          `INSERT INTO attention_items
             (id, kind, subject_id, project_path, severity, title, payload_json, status, created_at, updated_at)
           VALUES (?, 'tripped-breaker', 'loop-1', NULL, 3, 't', NULL, ?, ?, ?)`,
        )
        .run(id, status, now, now);
    insert('a', 'open');
    expect(() => insert('b', 'open')).toThrow(); // second OPEN row rejected
    expect(() => insert('c', 'resolved')).not.toThrow(); // resolved coexists with open
  });

  it('adds attention_items to a pre-existing DB that lacks it (migration-from-nothing)', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-attention-migrate-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    // A DB from before rung 3 — has other tables but no attention_items.
    const oldDb = new Database(join(dataDir, 'nuncio.db'));
    oldDb.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'CREATED', prompt TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    oldDb.close();

    db = new DatabaseService();
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('attention_items');
  });

  it('adds suppress_reraise to a pre-existing attention_items table (guarded ALTER)', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-attention-suppress-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    // An attention_items table from before the re-raise-suppression column.
    const oldDb = new Database(join(dataDir, 'nuncio.db'));
    oldDb.exec(
      `CREATE TABLE attention_items (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL,
        project_path TEXT, severity INTEGER NOT NULL, title TEXT NOT NULL,
        payload_json TEXT, status TEXT NOT NULL DEFAULT 'open', acknowledged_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER
      )`,
    );
    oldDb.prepare(
      "INSERT INTO attention_items (id, kind, subject_id, severity, title, status, created_at, updated_at) VALUES ('old', 'tripped-breaker', 'loop-1', 3, 't', 'open', 0, 0)",
    ).run();
    oldDb.close();

    db = new DatabaseService();
    const cols = db.db.prepare('PRAGMA table_info(attention_items)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('suppress_reraise');
    const row = db.db.prepare('SELECT suppress_reraise FROM attention_items WHERE id = ?').get('old') as {
      suppress_reraise: number;
    };
    expect(row.suppress_reraise).toBe(0); // NOT NULL DEFAULT 0
  });

  it('adds the project importance weight column (fresh + guarded ALTER)', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-project-weight-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    // A pre-existing projects table from before the rung-3 weight column.
    const oldDb = new Database(join(dataDir, 'nuncio.db'));
    oldDb.exec(
      `CREATE TABLE projects (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        default_engine TEXT,
        worktree_policy TEXT,
        verify_command TEXT,
        verify_auto_steer TEXT NOT NULL DEFAULT 'inherit',
        verify_max_rounds INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    oldDb.prepare("INSERT INTO projects (path, name, verify_auto_steer, created_at, updated_at) VALUES ('/p', 'p', 'inherit', 0, 0)").run();
    oldDb.close();

    db = new DatabaseService();
    const cols = db.db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('weight');
    const row = db.db.prepare('SELECT weight FROM projects WHERE path = ?').get('/p') as { weight: number | null };
    expect(row.weight).toBeNull(); // default applied by the repo, not the schema
  });

  it('creates the digest_runs marker table on a fresh DB (rung 3 sub-phase B)', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-digest-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();
    const cols = db.db.prepare('PRAGMA table_info(digest_runs)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual([
      'slot_key',
      'variant',
      'sent_at',
      'window_from',
      'window_to',
      'summary_json',
    ]);
    // slot_key is the PRIMARY KEY → a second insert of the same slot is rejected
    // (the durable not-double-sent guard).
    const ins = (n: number) =>
      db!.db
        .prepare(
          "INSERT INTO digest_runs (slot_key, variant, sent_at, window_from, window_to, summary_json) VALUES ('2026-07-07:morning', 'morning', ?, 0, ?, '{}')",
        )
        .run(n, n);
    ins(1);
    expect(() => ins(2)).toThrow();
  });

  it('adds digest_runs to a pre-existing DB that lacks it (migration-from-nothing)', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-digest-migrate-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    const oldDb = new Database(join(dataDir, 'nuncio.db'));
    oldDb.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'CREATED', prompt TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    oldDb.close();

    db = new DatabaseService();
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('digest_runs');
  });

  it('enables WAL journal mode', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-wal-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();
    const mode = db.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
  });

  it('onModuleDestroy closes the database handle', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-close-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();
    db.onModuleDestroy();
    expect(() => db!.db.prepare('SELECT 1').get()).toThrow();
    db = undefined; // afterEach would otherwise double-close
  });
});
