import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('SessionsRepository lineage', () => {
  let module: TestingModule;
  let repo: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-lineage-repo-'));
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

  it('round-trips lineage columns on create', () => {
    const parent = repo.create({ prompt: 'parent' });
    const child = repo.create({
      prompt: 'child',
      parentSessionId: parent.id,
      originTaskId: 'task-9',
    });
    const reread = repo.findById(child.id);
    expect(reread?.parentSessionId).toBe(parent.id);
    expect(reread?.originTaskId).toBe('task-9');
    expect(reread?.priorSessionId).toBeNull();
    // A plain session defaults all three to null.
    expect(repo.findById(parent.id)?.parentSessionId).toBeNull();
  });

  it('sets prior_session_id on a handoff successor', () => {
    const prior = repo.create({ prompt: 'prior' });
    const successor = repo.createHandoff({
      provider: 'pi',
      title: 'continued',
      workspace: '/repo',
      providerThreadId: 'thread-1',
      prompt: 'continued',
      priorSessionId: prior.id,
    });
    expect(repo.findById(successor.id)?.priorSessionId).toBe(prior.id);
  });

  it('lists children ordered by created_at', () => {
    const parent = repo.create({ prompt: 'multi-parent' });
    const a = repo.create({ prompt: 'child a', parentSessionId: parent.id });
    const b = repo.create({ prompt: 'child b', parentSessionId: parent.id });
    const children = repo.childrenOf(parent.id);
    expect(children.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(repo.childrenOf('no-such-parent')).toEqual([]);
  });
});
