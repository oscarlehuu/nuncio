import { Global, Injectable, OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  provider TEXT NOT NULL DEFAULT 'pi',
  model TEXT,
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
`;

@Global()
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db: Database;
  /** Resolved data directory (exposed so other services can colocate files, e.g. the settings key). */
  readonly dataDir: string;

  constructor() {
    const dataDir = process.env.NUNCIO_DATA_DIR ?? join(process.cwd(), 'data');
    mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.db = new Database(join(dataDir, 'nuncio.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  onModuleDestroy() {
    this.db.close();
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
        PRIMARY KEY (provider, delivery_id)
      )
    `);
  }
}
