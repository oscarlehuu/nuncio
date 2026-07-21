import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SessionTitleService } from '../../../src/sessions/session-title.service';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { AgentRegistry } from '../../../src/agents/agents.registry';
import type { AgentProvider } from '../../../src/agents/agents.types';
import type { SettingsService } from '../../../src/settings/settings.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

function makeTitleService(overrides: {
  completion?: string | Error;
  provider?: null;
  settings?: Record<string, string | undefined>;
}) {
  const completeOneShot = jest.fn(async () => {
    if (overrides.completion instanceof Error) throw overrides.completion;
    return overrides.completion ?? 'Fix login token refresh race';
  });
  const provider =
    overrides.provider === null
      ? undefined
      : ({ id: 'pi', name: 'Pi', completeOneShot } as unknown as AgentProvider);
  const agents = {
    available: jest.fn(async () => (provider ? [provider] : [])),
  } as unknown as AgentRegistry;
  const settings = {
    resolve: jest.fn((key: string) => (overrides.settings ?? {})[key]),
  } as unknown as SettingsService;
  const service = new SessionTitleService(agents, settings);
  return { service, completeOneShot };
}

describe('SessionTitleService.generateTitle', () => {
  it('produces a concise single-line title from the request', async () => {
    const { service, completeOneShot } = makeTitleService({
      completion: '"Fix login token refresh race."\nsecond line noise',
    });

    const title = await service.generateTitle('Please fix the auth bug where tokens…');

    expect(title).toBe('Fix login token refresh race');
    const input = (completeOneShot.mock.calls[0] as unknown as [{ prompt: string }])[0];
    expect(input.prompt).toContain('Please fix the auth bug');
  });

  it('returns null when no available engine supports one-shot completions', async () => {
    const { service } = makeTitleService({ provider: null });
    await expect(service.generateTitle('anything')).resolves.toBeNull();
  });

  it('returns null on an empty completion', async () => {
    const { service } = makeTitleService({ completion: '   ' });
    await expect(service.generateTitle('anything')).resolves.toBeNull();
  });

  it('returns null instead of throwing when the engine fails', async () => {
    const { service } = makeTitleService({ completion: new Error('engine down') });
    await expect(service.generateTitle('anything')).resolves.toBeNull();
  });

  it('caps runaway titles', async () => {
    const { service } = makeTitleService({ completion: 'word '.repeat(60) });
    const title = await service.generateTitle('anything');
    expect(title!.length).toBeLessThanOrEqual(80);
  });

  it('passes the configured model through', async () => {
    const { service, completeOneShot } = makeTitleService({
      settings: { NUNCIO_SESSION_TITLE_MODEL: 'cliproxyapi:claude-haiku-4-5' },
    });
    await service.generateTitle('anything');
    const input = (completeOneShot.mock.calls[0] as unknown as [{ model?: string | null }])[0];
    expect(input.model).toBe('cliproxyapi:claude-haiku-4-5');
  });
});

describe('SessionsService.applyAutoTitle', () => {
  let module: TestingModule;
  let service: SessionsService;
  let repo: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-auto-title-'));
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
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('applies the generated title while the derived title is untouched', () => {
    const session = repo.create({ prompt: 'fix the auth bug', provider: 'cursor' });

    service.applyAutoTitle(session.id, session.title, 'Fix auth token refresh');

    expect(repo.findById(session.id)?.title).toBe('Fix auth token refresh');
  });

  it('never clobbers a manual rename that happened in the meantime', () => {
    const session = repo.create({ prompt: 'fix the auth bug', provider: 'cursor' });
    service.rename(session.id, 'My own name');

    service.applyAutoTitle(session.id, session.title, 'Fix auth token refresh');

    expect(repo.findById(session.id)?.title).toBe('My own name');
  });
});
