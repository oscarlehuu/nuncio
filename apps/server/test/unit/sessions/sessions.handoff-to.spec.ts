import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { GitModule } from '../../../src/git/git.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('SessionsService.handoffToProvider', () => {
  let module: TestingModule;
  let service: SessionsService;
  let repo: SessionsRepository;
  let events: EventsRepository;
  let db: DatabaseService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-handoff-to-'));
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
    events = module.get(EventsRepository);
    db = module.get(DatabaseService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  function setStatus(id: string, status: string): void {
    db.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
  }

  function makeIdleSource(overrides: Record<string, unknown> = {}): SessionDto {
    const source = repo.create({
      prompt: 'Fix the auth bug in login flow',
      provider: 'cursor',
      workspace: '/tmp/nuncio-handoff-src',
      ...overrides,
    });
    setStatus(source.id, 'IDLE');
    events.append(source.id, 'user_message', { text: 'Fix the auth bug in login flow' });
    events.append(source.id, 'assistant_message', { text: 'I traced it to the token refresh.' });
    return source;
  }

  it('creates a new session on the target provider with lineage and compacted history', async () => {
    const source = makeIdleSource();

    const next = await service.handoffToProvider(source.id, { provider: 'cursor' });

    expect(next.id).not.toBe(source.id);
    expect(next.provider).toBe('cursor');
    expect(next.priorSessionId).toBe(source.id);
    // The handoff continues the same task — keep the source title, not the
    // first line of the composed preamble.
    expect(next.title).toBe(source.title);
    // The composed first prompt carries the handoff brief and the compacted timeline.
    expect(next.prompt).toContain('## Handoff brief');
    expect(next.prompt).toContain(`## Session ${source.id} since seq 0 (compacted)`);
    expect(next.prompt).toContain('**User:** Fix the auth bug in login flow');
    expect(next.prompt).toContain('I traced it to the token refresh.');
  });

  it('reuses the source workspace and keeps the model when the provider is unchanged', async () => {
    const source = makeIdleSource({ model: 'gpt-5.5-codex' });

    const next = await service.handoffToProvider(source.id, { provider: 'cursor' });

    expect(next.workspace).toBe('/tmp/nuncio-handoff-src');
    expect(next.model).toBe('gpt-5.5-codex');
  });

  it('honors an explicit target model and continue prompt', async () => {
    const source = makeIdleSource();

    const next = await service.handoffToProvider(source.id, {
      provider: 'cursor',
      model: 'gpt-5.4',
      prompt: 'Focus on the refresh-token race first.',
    });

    expect(next.model).toBe('gpt-5.4');
    expect(next.prompt.endsWith('Focus on the refresh-token race first.')).toBe(true);
  });

  it('rejects a running source session', async () => {
    const source = makeIdleSource();
    setStatus(source.id, 'RUNNING');

    await expect(service.handoffToProvider(source.id, { provider: 'cursor' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects handing off a fresh handoff that has no native assistant turn yet', async () => {
    const original = makeIdleSource();
    const second = repo.create({
      prompt: 'continue',
      provider: 'cursor',
      priorSessionId: original.id,
    });
    setStatus(second.id, 'IDLE');
    events.append(second.id, 'user_message', { text: 'continue' });

    await expect(service.handoffToProvider(second.id, { provider: 'cursor' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects an unknown target provider', async () => {
    const source = makeIdleSource();

    await expect(
      service.handoffToProvider(source.id, { provider: 'not-a-provider' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('blocks steering a source whose worktree has a live successor', async () => {
    const source = repo.create({
      prompt: 'src',
      provider: 'cursor',
      projectPath: '/tmp/nuncio-handoff-proj',
      worktreePath: '/tmp/nuncio-handoff-wt',
      branch: 'nuncio/src-task',
    });
    setStatus(source.id, 'IDLE');
    repo.create({
      prompt: 'continue',
      provider: 'cursor',
      priorSessionId: source.id,
      projectPath: '/tmp/nuncio-handoff-proj',
      worktreePath: '/tmp/nuncio-handoff-wt',
      branch: 'nuncio/src-task',
    });

    await expect(service.steer(source.id, 'keep going')).rejects.toThrow(BadRequestException);
  });

  it('blocks a second handoff while the successor is live, and allows it once archived', async () => {
    const source = makeIdleSource({
      worktreePath: '/tmp/nuncio-handoff-wt2',
      branch: 'nuncio/src2',
    });
    const successor = repo.create({
      prompt: 'continue',
      provider: 'cursor',
      priorSessionId: source.id,
      worktreePath: '/tmp/nuncio-handoff-wt2',
      branch: 'nuncio/src2',
    });

    await expect(service.handoffToProvider(source.id, { provider: 'cursor' })).rejects.toThrow(
      BadRequestException,
    );

    setStatus(successor.id, 'ARCHIVED');
    const next = await service.handoffToProvider(source.id, { provider: 'cursor' });
    expect(next.priorSessionId).toBe(source.id);
  });

  it('surfaces handoff links in lineage (successor as child, source as ancestor)', async () => {
    const source = makeIdleSource();
    const next = await service.handoffToProvider(source.id, { provider: 'cursor' });

    expect(service.lineage(source.id).children.map((c) => c.id)).toContain(next.id);
    expect(service.lineage(next.id).ancestors.map((a) => a.id)).toContain(source.id);
  });

  it('persists priorSessionId through the repository create path', () => {
    const source = repo.create({ prompt: 'src', provider: 'cursor' });
    const next = repo.create({ prompt: 'next', provider: 'cursor', priorSessionId: source.id });
    expect(next.priorSessionId).toBe(source.id);
    expect(repo.findById(next.id)?.priorSessionId).toBe(source.id);
  });
});
