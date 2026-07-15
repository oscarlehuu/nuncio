import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { DatabaseService } from '../../../src/db/database.service';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';

describe('SessionsRepository — forge state', () => {
  let database: DatabaseService;
  let repo: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-sessions-forge-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    database = new DatabaseService();
    repo = new SessionsRepository(database);
  });

  afterAll(async () => {
    database.onModuleDestroy();
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

  it('persists PR ownership on the initial session insert', () => {
    const owner = repo.create({
      prompt: 'adopt atomically',
      projectPath: '/projects/nuncio',
      forgeProvider: 'github',
      pullRequestUrl: 'https://github.com/octo/nuncio/pull/45',
      pullRequestNumber: 45,
      pullRequestState: 'open',
      forgeStatus: 'open',
    });

    expect(repo.findByProjectPullRequest('/projects/nuncio', 45)?.id).toBe(owner.id);
    expect(repo.claimPullRequestAdoption('/projects/nuncio', 45, 'retry')).toEqual({
      status: 'existing',
      sessionId: owner.id,
    });
  });

  it('finds the owning session by project path and pull-request number', () => {
    const owner = repo.create({ prompt: 'owner', projectPath: '/projects/nuncio' });
    const collision = repo.create({ prompt: 'other repo', projectPath: '/projects/other' });
    repo.updateForgeState(owner.id, { pullRequestNumber: 17, forgeProvider: 'github' });
    repo.updateForgeState(collision.id, { pullRequestNumber: 17, forgeProvider: 'github' });

    expect(repo.findByProjectPullRequest('/projects/nuncio', 17)?.id).toBe(owner.id);
    expect(repo.findByProjectPullRequest('/projects/missing', 17)).toBeNull();
  });

  it('includes an archived owner only when lifecycle routing requests it', () => {
    const owner = repo.create({ prompt: 'archived owner', projectPath: '/projects/nuncio' });
    repo.updateForgeState(owner.id, { pullRequestNumber: 18, forgeProvider: 'github' });
    repo.updateStatus(owner.id, 'RUNNING');
    repo.updateStatus(owner.id, 'IDLE');
    repo.updateStatus(owner.id, 'ARCHIVED');

    expect(repo.findByProjectPullRequest('/projects/nuncio', 18)).toBeNull();
    expect(
      repo.findByProjectPullRequest('/projects/nuncio', 18, { includeArchived: true })?.id,
    ).toBe(owner.id);
  });

  it('atomically reserves one active session owner per project pull request', () => {
    const competingDatabase = new DatabaseService();
    const competingRepo = new SessionsRepository(competingDatabase);
    const claims = repo as unknown as {
      claimPullRequestAdoption: (path: string, number: number, token: string) =>
        | { status: 'claimed' }
        | { status: 'existing'; sessionId: string }
        | { status: 'pending' };
      completePullRequestAdoption: (
        path: string,
        number: number,
        token: string,
        sessionId: string,
        state: Record<string, unknown>,
      ) => void;
    };
    const competingClaims = competingRepo as unknown as Pick<
      typeof claims,
      'claimPullRequestAdoption'
    >;

    try {
      expect(claims.claimPullRequestAdoption('/projects/nuncio', 44, 'first')).toEqual({
        status: 'claimed',
      });
      expect(competingClaims.claimPullRequestAdoption('/projects/nuncio', 44, 'second')).toEqual({
        status: 'pending',
      });

      const owner = repo.create({ prompt: 'adopt PR', projectPath: '/projects/nuncio' });
      claims.completePullRequestAdoption('/projects/nuncio', 44, 'first', owner.id, {
        forgeProvider: 'github',
        pullRequestUrl: 'https://github.com/octo/nuncio/pull/44',
        pullRequestState: 'open',
        forgeStatus: 'open',
      });
      expect(competingClaims.claimPullRequestAdoption('/projects/nuncio', 44, 'third')).toEqual({
        status: 'existing',
        sessionId: owner.id,
      });

      repo.updateStatus(owner.id, 'RUNNING');
      repo.updateStatus(owner.id, 'IDLE');
      repo.updateStatus(owner.id, 'ARCHIVED');
      expect(competingClaims.claimPullRequestAdoption('/projects/nuncio', 44, 'fourth')).toEqual({
        status: 'claimed',
      });
    } finally {
      competingDatabase.onModuleDestroy();
    }
  });

  it('does not let a later database connection erase a live pending claim', () => {
    expect(repo.claimPullRequestAdoption('/projects/nuncio', 46, 'first-process')).toEqual({
      status: 'claimed',
    });
    const lateDatabase = new DatabaseService();
    try {
      const lateRepo = new SessionsRepository(lateDatabase);
      expect(lateRepo.claimPullRequestAdoption('/projects/nuncio', 46, 'second-process')).toEqual({
        status: 'pending',
      });
    } finally {
      repo.releasePullRequestAdoption('/projects/nuncio', 46, 'first-process');
      lateDatabase.onModuleDestroy();
    }
  });

  it('allows an abandoned adoption claim to be reclaimed after its lease expires', () => {
    expect(repo.claimPullRequestAdoption('/projects/nuncio', 47, 'crashed-request')).toEqual({
      status: 'claimed',
    });
    database.db
      .prepare(
        `UPDATE forge_pr_session_claims SET lease_expires_at = 0
         WHERE project_path = ? AND pull_request_number = ?`,
      )
      .run('/projects/nuncio', 47);

    expect(repo.claimPullRequestAdoption('/projects/nuncio', 47, 'replacement')).toEqual({
      status: 'claimed',
    });
    repo.releasePullRequestAdoption('/projects/nuncio', 47, 'replacement');
  });

  it('allows only one non-archived session owner after an expired claimant resumes', () => {
    expect(repo.claimPullRequestAdoption('/projects/nuncio', 48, 'stale-request')).toEqual({
      status: 'claimed',
    });
    database.db
      .prepare(
        `UPDATE forge_pr_session_claims SET lease_expires_at = 0
         WHERE project_path = ? AND pull_request_number = ?`,
      )
      .run('/projects/nuncio', 48);
    expect(repo.claimPullRequestAdoption('/projects/nuncio', 48, 'replacement')).toEqual({
      status: 'claimed',
    });

    const winner = repo.create({
      prompt: 'replacement owner',
      projectPath: '/projects/nuncio',
      pullRequestNumber: 48,
    });
    expect(() => repo.create({
      prompt: 'stale request resumed',
      projectPath: '/projects/nuncio',
      pullRequestNumber: 48,
    })).toThrow();

    repo.updateStatus(winner.id, 'RUNNING');
    repo.updateStatus(winner.id, 'IDLE');
    repo.updateStatus(winner.id, 'ARCHIVED');
    expect(() => repo.create({
      prompt: 'new owner after archive',
      projectPath: '/projects/nuncio',
      pullRequestNumber: 48,
    })).not.toThrow();
  });

  it('reclaims a completed claim whose session no longer owns that pull request', () => {
    expect(repo.claimPullRequestAdoption('/projects/nuncio', 49, 'original')).toEqual({
      status: 'claimed',
    });
    const owner = repo.create({ prompt: 'moving owner', projectPath: '/projects/nuncio' });
    repo.completePullRequestAdoption('/projects/nuncio', 49, 'original', owner.id, {
      forgeProvider: 'github',
      pullRequestUrl: 'https://github.com/octo/nuncio/pull/49',
      pullRequestState: 'open',
      forgeStatus: 'open',
    });
    repo.updateForgeState(owner.id, {
      pullRequestUrl: 'https://github.com/octo/nuncio/pull/50',
      pullRequestNumber: 50,
    });

    expect(repo.claimPullRequestAdoption('/projects/nuncio', 49, 'replacement')).toEqual({
      status: 'claimed',
    });
    repo.releasePullRequestAdoption('/projects/nuncio', 49, 'replacement');
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

  it('keeps the newest active PR owner when adding the uniqueness index', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-forge-owner-migrate-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    db = new DatabaseService();
    db.db.exec('DROP INDEX sessions_active_project_pr_unique');
    const legacyRepo = new SessionsRepository(db);
    const older = legacyRepo.create({
      prompt: 'older owner',
      projectPath: '/projects/nuncio',
      pullRequestNumber: 70,
      forgeProvider: 'github',
      pullRequestUrl: 'https://github.com/octo/nuncio/pull/70',
      pullRequestState: 'open',
      forgeStatus: 'open',
    });
    const newer = legacyRepo.create({
      prompt: 'newer owner',
      projectPath: '/projects/nuncio',
      pullRequestNumber: 70,
      forgeProvider: 'github',
      pullRequestUrl: 'https://github.com/octo/nuncio/pull/70',
      pullRequestState: 'open',
      forgeStatus: 'open',
    });
    db.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(1, older.id);
    db.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(2, newer.id);
    db.onModuleDestroy();
    db = undefined;

    db = new DatabaseService();
    const migratedRepo = new SessionsRepository(db);
    expect(migratedRepo.findById(newer.id)?.pullRequestNumber).toBe(70);
    expect(migratedRepo.findById(older.id)).toMatchObject({
      forgeProvider: null,
      pullRequestUrl: null,
      pullRequestNumber: null,
      pullRequestState: null,
      forgeStatus: 'none',
    });
  });
});
