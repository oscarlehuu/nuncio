import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('SessionsRepository', () => {
  let module: TestingModule;
  let repo: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-sessions-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    repo = module.get(SessionsRepository);
    events = module.get(EventsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('create stores provider, model, and workspace fields', () => {
    const s = repo.create({
      prompt: 'do thing',
      provider: 'cursor',
      model: 'm1',
      modelOptions: { fast: true, thinkingLevel: 'high' },
      projectPath: '/p',
      baseBranch: 'main',
      worktreePath: '/w',
      branch: 'nuncio/x',
    });
    expect(s.provider).toBe('cursor');
    expect(s.model).toBe('m1');
    expect(s.modelOptions).toEqual({ fast: true, thinkingLevel: 'high' });
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

  describe('delete', () => {
    it('removes the session row', () => {
      const s = repo.create({ prompt: 'delete me' });
      repo.delete(s.id);
      expect(repo.findById(s.id)).toBeNull();
    });

    it('cascades the delete to the session events', () => {
      const s = repo.create({ prompt: 'delete with events' });
      events.append(s.id, 'user_message', { text: 'hi' });
      events.append(s.id, 'assistant_message', { text: 'hello' });
      expect(events.list(s.id)).toHaveLength(2);

      repo.delete(s.id);

      expect(events.list(s.id)).toHaveLength(0);
      expect(repo.findById(s.id)).toBeNull();
    });

    it('does not affect other sessions or their events', () => {
      const keep = repo.create({ prompt: 'keep me' });
      const drop = repo.create({ prompt: 'drop me' });
      events.append(keep.id, 'user_message', { text: 'keep-1' });
      events.append(drop.id, 'user_message', { text: 'drop-1' });

      repo.delete(drop.id);

      expect(repo.findById(keep.id)).not.toBeNull();
      expect(events.list(keep.id)).toHaveLength(1);
      expect(repo.findById(drop.id)).toBeNull();
    });

    it('is a no-op for a missing id', () => {
      expect(() => repo.delete('does-not-exist')).not.toThrow();
    });
  });
});
