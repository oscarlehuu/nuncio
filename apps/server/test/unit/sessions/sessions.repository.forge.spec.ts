import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('SessionsRepository — forge state', () => {
  let module: TestingModule;
  let repo: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-sessions-forge-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    repo = module.get(SessionsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('new sessions default forgeStatus to none and the rest to null', () => {
    const s = repo.create({ prompt: 'fresh session' });
    expect(s.forgeStatus).toBe('none');
    expect(s.forgeProvider).toBeNull();
    expect(s.pullRequestUrl).toBeNull();
    expect(s.pullRequestNumber).toBeNull();
    expect(s.pullRequestState).toBeNull();
  });

  it('updateForgeState round-trips the new fields through toDto', () => {
    const s = repo.create({ prompt: 'open a pr' });
    const updated = repo.updateForgeState(s.id, {
      forgeProvider: 'github',
      pullRequestUrl: 'https://github.com/octo/nuncio/pull/12',
      pullRequestNumber: 12,
      pullRequestState: 'open',
      forgeStatus: 'open',
    });

    expect(updated.forgeProvider).toBe('github');
    expect(updated.pullRequestUrl).toBe('https://github.com/octo/nuncio/pull/12');
    expect(updated.pullRequestNumber).toBe(12);
    expect(updated.pullRequestState).toBe('open');
    expect(updated.forgeStatus).toBe('open');

    const reread = repo.findById(s.id)!;
    expect(reread.pullRequestNumber).toBe(12);
    expect(reread.forgeStatus).toBe('open');
  });

  it('updateForgeState preserves untouched fields', () => {
    const s = repo.create({ prompt: 'partial update' });
    repo.updateForgeState(s.id, { forgeStatus: 'opening' });
    const after = repo.updateForgeState(s.id, {
      pullRequestUrl: 'https://github.com/octo/nuncio/pull/5',
    });
    expect(after.forgeStatus).toBe('opening');
    expect(after.pullRequestUrl).toBe('https://github.com/octo/nuncio/pull/5');
  });
});

describe('DatabaseService — forge column migration', () => {
  let db: DatabaseService | undefined;
  let dataDir: string;

  afterEach(() => {
    db?.onModuleDestroy();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('fresh schema includes the forge columns', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-forge-fresh-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();
    const cols = (db.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('forge_provider');
    expect(cols).toContain('pull_request_url');
    expect(cols).toContain('pull_request_number');
    expect(cols).toContain('pull_request_state');
    expect(cols).toContain('forge_status');
  });

  it('migrates a legacy sessions table (without forge columns) via migrate()', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-forge-migrate-'));
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
         VALUES ('legacy', 't', 'IDLE', NULL, 'p', NULL, 0, 0)`,
      )
      .run();
    oldDb.close();

    db = new DatabaseService();
    const cols = (db.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('forge_provider');
    expect(cols).toContain('pull_request_url');
    expect(cols).toContain('pull_request_number');
    expect(cols).toContain('pull_request_state');
    expect(cols).toContain('forge_status');

    const row = db.db
      .prepare('SELECT forge_provider, forge_status, pull_request_number FROM sessions WHERE id = ?')
      .get('legacy') as {
      forge_provider: string | null;
      forge_status: string | null;
      pull_request_number: number | null;
    };
    expect(row.forge_provider).toBeNull();
    expect(row.pull_request_number).toBeNull();
    expect(row.forge_status).toBe('none');
  });
});
