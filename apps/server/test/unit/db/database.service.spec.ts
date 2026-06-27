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

  it('fresh schema includes a provider column on sessions', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-db-fresh-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();
    const cols = db.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    expect(cols.map((column) => column.name)).toContain('provider');
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

  it('migrates a pre-existing sessions table by adding the provider column', () => {
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

    const row = db.db.prepare('SELECT provider FROM sessions WHERE id = ?').get('old') as {
      provider: string;
    };
    expect(row.provider).toBe('pi');
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
