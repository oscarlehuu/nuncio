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

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_cli_chat_unique
      ON sessions(cursor_chat_id) WHERE cursor_backend = 'cli'
    `);
  }
}
