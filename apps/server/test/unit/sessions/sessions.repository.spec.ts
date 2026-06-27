import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('SessionsRepository', () => {
  let module: TestingModule;
  let repo: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-sessions-repo-'));
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

  it('create stores provider, model, and workspace fields', () => {
    const s = repo.create({
      prompt: 'do thing',
      provider: 'mock',
      model: 'm1',
      projectPath: '/p',
      baseBranch: 'main',
      worktreePath: '/w',
      branch: 'nuncio/x',
    });
    expect(s.provider).toBe('mock');
    expect(s.model).toBe('m1');
    expect(s.projectPath).toBe('/p');
    expect(s.baseBranch).toBe('main');
    expect(s.worktreePath).toBe('/w');
    expect(s.branch).toBe('nuncio/x');
  });

  it('create defaults provider to pi and nulls the rest when omitted', () => {
    const s = repo.create({ prompt: 'defaults' });
    expect(s.provider).toBe('pi');
    expect(s.model).toBeNull();
    expect(s.projectPath).toBeNull();
    expect(s.branch).toBeNull();
  });

  it('findById returns null for a missing id', () => {
    expect(repo.findById('nope')).toBeNull();
  });

  it('touchPreview truncates the preview to 200 characters', () => {
    const s = repo.create({ prompt: 'preview me' });
    repo.touchPreview(s.id, 'x'.repeat(500));
    const found = repo.findById(s.id);
    expect(found?.preview?.length).toBe(200);
    expect(found?.preview).toBe('x'.repeat(200));
  });

  it('list orders by updated_at descending', async () => {
    const a = repo.create({ prompt: 'older one' });
    const b = repo.create({ prompt: 'newer one' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    repo.touchPreview(a.id, 'bump a to the front');
    const listed = repo.list();
    expect(listed[0].id).toBe(a.id);
    expect(listed.find((s) => s.id === b.id)).toBeDefined();
  });

  it('updateStatus throws for a missing session', () => {
    expect(() => repo.updateStatus('missing', 'RUNNING')).toThrow();
  });

  it('updateStatus applies and returns the new status', () => {
    const s = repo.create({ prompt: 'transition me' });
    const updated = repo.updateStatus(s.id, 'RUNNING');
    expect(updated.status).toBe('RUNNING');
    expect(repo.findById(s.id)?.status).toBe('RUNNING');
  });
});
