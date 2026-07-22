import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';

const { Database } = require('bun:sqlite');
const SERVER_ROOT = process.cwd();
const CHILD = join(SERVER_ROOT, 'test/unit/db/database-upgrade-child.ts');

interface ChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function createCoreReleaseSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'CREATED', provider TEXT NOT NULL DEFAULT 'pi',
      model TEXT, workspace TEXT, prompt TEXT NOT NULL, preview TEXT,
      project_path TEXT, base_branch TEXT, worktree_path TEXT, branch TEXT,
      provider_thread_id TEXT, provider_active_turn_id TEXT, provider_state_json TEXT,
      forge_provider TEXT, pull_request_url TEXT, pull_request_number INTEGER,
      pull_request_state TEXT, forge_status TEXT NOT NULL DEFAULT 'none',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
}

function createLoopReleaseSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, spec TEXT NOT NULL, target_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, next_fire_at INTEGER, last_fire_at INTEGER,
      last_result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE loops (
      id TEXT PRIMARY KEY, goal TEXT NOT NULL, schedule_id TEXT NOT NULL,
      max_runs_per_day INTEGER NOT NULL, max_consecutive_failures INTEGER NOT NULL,
      stop_json TEXT, escalation TEXT NOT NULL, project_path TEXT,
      status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE loop_runs (
      id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, task_id TEXT, outcome TEXT NOT NULL,
      verify TEXT NOT NULL DEFAULT 'none', day_bucket TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'QUEUED',
      provider TEXT, model TEXT, model_options TEXT, project_path TEXT, base_branch TEXT,
      use_worktree INTEGER NOT NULL DEFAULT 0, workspace TEXT, parent_session_id TEXT,
      role TEXT NOT NULL DEFAULT 'standalone', cleanup_policy TEXT, review_state TEXT,
      session_id TEXT, outcome_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE steer_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      message TEXT NOT NULL, attachments_json TEXT, created_at INTEGER NOT NULL
    );
  `);
}

async function runChild(args: string[]): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, CHILD, ...args], {
    cwd: SERVER_ROOT,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function columns(db: InstanceType<typeof Database>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function schemaSnapshot(service: DatabaseService): unknown[] {
  return service.db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
}

function expectChildSuccess(child: ChildResult): void {
  expect({ exitCode: child.exitCode, stderr: child.stderr }).toEqual({ exitCode: 0, stderr: '' });
  expect(child.stdout).toContain('"status":"ok"');
}

describe('DatabaseService serialized and interrupted upgrade recovery', () => {
  let dataDir = '';
  let gateDir = '';
  let service: DatabaseService | undefined;

  afterEach(() => {
    service?.onModuleDestroy();
    service = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (gateDir) rmSync(gateDir, { recursive: true, force: true });
    dataDir = '';
    gateDir = '';
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('serializes two upgrade processes and rechecks guarded columns inside the write lock', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-upgrade-race-'));
    gateDir = mkdtempSync(join(tmpdir(), 'nuncio-db-upgrade-race-gate-'));
    const seeded = new Database(join(dataDir, 'nuncio.db'));
    seeded.exec('PRAGMA journal_mode = WAL');
    createCoreReleaseSchema(seeded);
    seeded.prepare(
      "INSERT INTO sessions (id, title, status, provider, prompt, forge_status, created_at, updated_at) VALUES ('race', '競合', 'IDLE', 'pi', 'keep', 'none', 0, 0)",
    ).run();
    seeded.close();

    const [firstChild, secondChild] = await Promise.all([
      runChild(['race', dataDir, 'a', gateDir]),
      runChild(['race', dataDir, 'b', gateDir]),
    ]);
    expectChildSuccess(firstChild);
    expectChildSuccess(secondChild);

    process.env.NUNCIO_DATA_DIR = dataDir;
    service = new DatabaseService();
    const firstSchema = schemaSnapshot(service);
    expect(columns(service.db, 'sessions').filter((name) => name === 'model_options')).toEqual([
      'model_options',
    ]);
    expect(service.db.prepare<{ title: string }, []>('SELECT title FROM sessions').get()).toEqual({
      title: '競合',
    });
    expect(service.db.prepare<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
      .toBeGreaterThan(0);

    service.onModuleDestroy();
    service = new DatabaseService();
    expect(schemaSnapshot(service)).toEqual(firstSchema);
  });

  it('recovers after a hard-killed early guarded ALTER without losing the existing session', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-upgrade-core-'));
    gateDir = mkdtempSync(join(tmpdir(), 'nuncio-db-upgrade-core-gate-'));
    const seeded = new Database(join(dataDir, 'nuncio.db'));
    seeded.exec('PRAGMA journal_mode = WAL');
    createCoreReleaseSchema(seeded);
    seeded.prepare(
      `INSERT INTO sessions
         (id, title, status, provider, model, workspace, prompt, preview,
          forge_status, created_at, updated_at)
       VALUES (?, ?, 'IDLE', 'pi', NULL, ?, ?, ?, 'none', 0, 7)`,
    ).run('session-old', 'Révision 工具', '/tmp/répo', 'préserve-moi', 'aperçu');
    seeded.prepare("INSERT INTO settings VALUES ('legacy', '✓', 0)").run();
    seeded.close();

    const killed = await runChild([
      'kill-after', dataDir, gateDir, 'ALTER TABLE sessions ADD COLUMN model_options TEXT',
    ]);
    expect(killed.exitCode).not.toBe(0);
    expect(existsSync(join(gateDir, 'failpoint-hit'))).toBe(true);

    const partial = new Database(join(dataDir, 'nuncio.db'));
    expect(columns(partial, 'sessions')).not.toContain('model_options');
    expect(partial.prepare('SELECT prompt, created_at, updated_at FROM sessions').get()).toEqual({
      prompt: 'préserve-moi',
      created_at: 0,
      updated_at: 7,
    });
    const partialVersion = partial.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | null;
    expect(partialVersion?.user_version ?? 0).toBe(0);
    partial.close();

    process.env.NUNCIO_DATA_DIR = dataDir;
    service = new DatabaseService();
    const firstSchema = schemaSnapshot(service);
    expect(columns(service.db, 'sessions')).toEqual(expect.arrayContaining([
      'model_options', 'mode', 'runtime_policy_json', 'mcp_server_ids_json', 'verify_owner',
      'prior_session_id',
    ]));
    expect(service.db.prepare('SELECT value, updated_at FROM settings WHERE key = ?').get('legacy'))
      .toEqual({ value: '✓', updated_at: 0 });
    expect(service.db.prepare(
      'SELECT title, workspace, prompt, provider, model_options, mode FROM sessions WHERE id = ?',
    ).get('session-old')).toEqual({
      title: 'Révision 工具',
      workspace: '/tmp/répo',
      prompt: 'préserve-moi',
      provider: 'pi',
      model_options: null,
      mode: null,
    });

    service.onModuleDestroy();
    service = new DatabaseService();
    expect(schemaSnapshot(service)).toEqual(firstSchema);
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
  });

  it('recovers after a hard-killed late guarded ALTER with scheduler and queue data intact', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-upgrade-loop-'));
    gateDir = mkdtempSync(join(tmpdir(), 'nuncio-db-upgrade-loop-gate-'));
    const seeded = new Database(join(dataDir, 'nuncio.db'));
    seeded.exec('PRAGMA journal_mode = WAL');
    createCoreReleaseSchema(seeded);
    createLoopReleaseSchema(seeded);
    seeded.prepare(
      "INSERT INTO sessions (id, title, status, provider, prompt, forge_status, created_at, updated_at) VALUES ('session-old', '旧', 'IDLE', 'pi', 'keep', 'none', 0, 0)",
    ).run();
    seeded.prepare(
      `INSERT INTO schedules VALUES ('schedule-old', 'cron', 'daily@09:00', ?, 1, 0, 0, NULL, 0, 0)`,
    ).run('{"kind":"loop","loopId":"loop-old"}');
    seeded.prepare(
      "INSERT INTO loops VALUES ('loop-old', '目標', 'schedule-old', 1, 3, NULL, 'needs-attention', '/tmp/répo', 'active', 0, 0)",
    ).run();
    seeded.prepare(
      "INSERT INTO tasks (id, prompt, status, use_worktree, role, created_at, updated_at, started_at) VALUES ('task-old', '继续', 'RUNNING', 0, 'standalone', 0, 0, 0)",
    ).run();
    seeded.prepare(
      "INSERT INTO loop_runs VALUES ('run-old', 'loop-old', 'task-old', 'pending', 'none', '2026-07-21', 0)",
    ).run();
    seeded.prepare(
      "INSERT INTO steer_queue (session_id, message, created_at) VALUES ('session-old', '再開', 0)",
    ).run();
    seeded.close();

    const killed = await runChild([
      'kill-after', dataDir, gateDir, 'ALTER TABLE steer_queue ADD COLUMN claimed_at INTEGER',
    ]);
    expect(killed.exitCode).not.toBe(0);
    expect(existsSync(join(gateDir, 'failpoint-hit'))).toBe(true);

    const partial = new Database(join(dataDir, 'nuncio.db'));
    expect(columns(partial, 'schedules')).not.toContain('generation');
    expect(columns(partial, 'tasks')).not.toContain('schedule_dispatch_intent_id');
    expect(columns(partial, 'steer_queue')).not.toContain('claimed_at');
    expect(partial.prepare("SELECT name FROM sqlite_master WHERE name = 'mcp_servers'").get()).toBeNull();
    expect(partial.prepare('SELECT prompt, started_at FROM tasks').get()).toEqual({
      prompt: '继续',
      started_at: 0,
    });
    partial.close();

    process.env.NUNCIO_DATA_DIR = dataDir;
    service = new DatabaseService();
    const firstSchema = schemaSnapshot(service);
    expect(service.db.prepare('SELECT spec, generation, next_fire_at FROM schedules').get()).toEqual({
      spec: 'daily@09:00', generation: 0, next_fire_at: 0,
    });
    expect(service.db.prepare('SELECT goal, name, engine, model FROM loops').get()).toEqual({
      goal: '目標', name: null, engine: null, model: null,
    });
    expect(service.db.prepare(
      'SELECT prompt, started_at, schedule_dispatch_intent_id FROM tasks',
    ).get()).toEqual({ prompt: '继续', started_at: 0, schedule_dispatch_intent_id: null });
    expect(service.db.prepare(
      'SELECT task_id, schedule_dispatch_intent_id FROM loop_runs',
    ).get()).toEqual({ task_id: 'task-old', schedule_dispatch_intent_id: null });
    expect(service.db.prepare(
      'SELECT message, claimed_at, origin, failure_context_json FROM steer_queue',
    ).get()).toEqual({ message: '再開', claimed_at: null, origin: null, failure_context_json: null });
    expect(service.db.prepare("SELECT name FROM sqlite_master WHERE name = 'mcp_servers'").get())
      .toEqual({ name: 'mcp_servers' });

    service.onModuleDestroy();
    service = new DatabaseService();
    expect(schemaSnapshot(service)).toEqual(firstSchema);
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM loop_runs').get()).toEqual({ count: 1 });
  });
});
