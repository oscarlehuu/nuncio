import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { GitModule } from '../../../src/git/git.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('SessionsService.lineage', () => {
  let module: TestingModule;
  let service: SessionsService;
  let repo: SessionsRepository;
  let db: DatabaseService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-lineage-svc-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
    repo = module.get(SessionsRepository);
    db = module.get(DatabaseService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  function link(childId: string, parentId: string): void {
    db.db.prepare('UPDATE sessions SET parent_session_id = ? WHERE id = ?').run(parentId, childId);
  }

  it('returns both children and each child sees the parent as an ancestor', () => {
    const parent = repo.create({ prompt: 'parent' });
    const childA = repo.create({ prompt: 'child a', parentSessionId: parent.id });
    const childB = repo.create({ prompt: 'child b', parentSessionId: parent.id });

    const parentLineage = service.lineage(parent.id);
    expect(parentLineage.ancestors).toEqual([]);
    expect(parentLineage.children.map((c) => c.id)).toEqual([childA.id, childB.id]);
    // SessionRefDto shape.
    expect(parentLineage.children[0]).toEqual({
      id: childA.id,
      title: childA.title,
      status: childA.status,
      provider: childA.provider,
    });

    const childLineage = service.lineage(childA.id);
    expect(childLineage.ancestors.map((a) => a.id)).toEqual([parent.id]);
    expect(childLineage.children).toEqual([]);
  });

  it('caps the ancestor walk at 10', () => {
    // Build a chain of 15 sessions, each parented to the previous.
    let previous = repo.create({ prompt: 'root' }).id;
    let deepest = previous;
    for (let i = 0; i < 15; i += 1) {
      const next = repo.create({ prompt: `link ${i}`, parentSessionId: previous });
      previous = next.id;
      deepest = next.id;
    }
    expect(service.lineage(deepest).ancestors).toHaveLength(10);
  });

  it('survives a manufactured parentage cycle without looping forever', () => {
    const a = repo.create({ prompt: 'cycle a' });
    const b = repo.create({ prompt: 'cycle b', parentSessionId: a.id });
    // Close the loop: a's parent becomes b.
    link(a.id, b.id);

    const lineage = service.lineage(a.id);
    // Walk visits b then stops (a already visited) — bounded, no hang.
    expect(lineage.ancestors.map((x) => x.id)).toEqual([b.id]);
  });

  it('throws NotFound for an unknown session', () => {
    expect(() => service.lineage('no-such-session')).toThrow(NotFoundException);
  });
});
