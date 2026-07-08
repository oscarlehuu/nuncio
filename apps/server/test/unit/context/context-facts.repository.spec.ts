import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { ContextFactsRepository } from '../../../src/context/context-facts.repository';

describe('ContextFactsRepository', () => {
  let module: TestingModule;
  let repo: ContextFactsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-facts-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [ContextFactsRepository],
    }).compile();
    repo = module.get(ContextFactsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('inserts and reads a fact by project', () => {
    const fact = repo.upsert({ projectPath: '/a', key: 'build-command', value: 'make', provenance: 'founder' });
    expect(fact.key).toBe('build-command');
    expect(fact.provenance).toBe('founder');
    expect(fact.pinned).toBe(false);
    expect(repo.list('/a').map((f) => f.key)).toEqual(['build-command']);
    expect(repo.get(fact.id)?.value).toBe('make');
  });

  it('upsert on an existing (project,key) preserves id + created_at and updates value', async () => {
    const first = repo.upsert({ projectPath: '/b', key: 'k', value: 'v1', provenance: 'founder' });
    await new Promise((r) => setTimeout(r, 5));
    const second = repo.upsert({ projectPath: '/b', key: 'k', value: 'v2', provenance: 'agent', sourceSessionId: 's1' });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(second.value).toBe('v2');
    expect(second.provenance).toBe('agent');
    expect(second.sourceSessionId).toBe('s1');
    // Still one row for the key.
    expect(repo.list('/b')).toHaveLength(1);
  });

  it('isolates facts per project (no bleed)', () => {
    repo.upsert({ projectPath: '/proj-x', key: 'shared', value: 'x', provenance: 'founder' });
    repo.upsert({ projectPath: '/proj-y', key: 'shared', value: 'y', provenance: 'founder' });
    expect(repo.list('/proj-x').map((f) => f.value)).toEqual(['x']);
    expect(repo.list('/proj-y').map((f) => f.value)).toEqual(['y']);
  });

  it('listPinnedFirst orders pinned facts first, then updated_at desc, bounded', async () => {
    const p = '/pinned';
    repo.upsert({ projectPath: p, key: 'a', value: '1', provenance: 'founder' });
    await new Promise((r) => setTimeout(r, 5));
    repo.upsert({ projectPath: p, key: 'b', value: '2', provenance: 'founder' });
    await new Promise((r) => setTimeout(r, 5));
    repo.upsert({ projectPath: p, key: 'c', value: '3', provenance: 'founder', pinned: true });

    const ordered = repo.listPinnedFirst(p, 10).map((f) => f.key);
    expect(ordered[0]).toBe('c'); // pinned first
    // remaining ordered by updated_at desc: b before a
    expect(ordered.slice(1)).toEqual(['b', 'a']);
    expect(repo.listPinnedFirst(p, 2)).toHaveLength(2);
  });

  it('deletes by id', () => {
    const fact = repo.upsert({ projectPath: '/del', key: 'gone', value: 'v', provenance: 'founder' });
    expect(repo.delete(fact.id)).toBe(true);
    expect(repo.get(fact.id)).toBeNull();
    expect(repo.delete('nope')).toBe(false);
  });

  it('getByKey finds a fact by project + key', () => {
    repo.upsert({ projectPath: '/bykey', key: 'thing', value: 'v', provenance: 'founder' });
    expect(repo.getByKey('/bykey', 'thing')?.value).toBe('v');
    expect(repo.getByKey('/bykey', 'missing')).toBeNull();
  });
});
