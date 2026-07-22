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

  it("prefers the session's own engine when it supports one-shot completions", async () => {
    const piShot = jest.fn(async () => 'From pi');
    const claudeShot = jest.fn(async () => 'From claude');
    const agents = {
      available: jest.fn(async () => [
        { id: 'pi', name: 'Pi', completeOneShot: piShot },
        { id: 'claude', name: 'Claude', completeOneShot: claudeShot },
      ]),
    } as unknown as AgentRegistry;
    const service = new SessionTitleService(agents);

    const title = await service.generateTitle('anything', 'claude');

    expect(title).toBe('From claude');
    expect(claudeShot).toHaveBeenCalledTimes(1);
    expect(piShot).not.toHaveBeenCalled();
  });

  it('asks for distinguishing identifiers in the title instruction', async () => {
    const { service, completeOneShot } = makeTitleService({});
    await service.generateTitle('Fix PR #141 review feedback');
    const input = (completeOneShot.mock.calls[0] as unknown as [{ systemPrompt?: string }])[0];
    expect(input.systemPrompt).toMatch(/identifiers/i);
    expect(input.systemPrompt).toMatch(/noun or verb phrase/i);
  });
});

describe('SessionTitleService.generateBranchSlug', () => {
  it('turns the completion into a clean branch fragment', async () => {
    const { service } = makeTitleService({ completion: 'Fix auth refresh race' });
    await expect(service.generateBranchSlug('anything')).resolves.toBe('fix-auth-refresh-race');
  });

  it('strips quotes, refs/heads and an echoed nuncio/ prefix', async () => {
    const { service } = makeTitleService({ completion: '"refs/heads/nuncio/fix-login-flow"' });
    await expect(service.generateBranchSlug('anything')).resolves.toBe('fix-login-flow');
  });

  it('caps runaway fragments at 64 characters', async () => {
    const { service } = makeTitleService({ completion: 'word '.repeat(40) });
    const slug = await service.generateBranchSlug('anything');
    expect(slug!.length).toBeLessThanOrEqual(64);
    expect(slug).not.toMatch(/-$/);
  });

  it('returns null when nothing usable remains after sanitizing', async () => {
    const { service } = makeTitleService({ completion: '!!! ???' });
    await expect(service.generateBranchSlug('anything')).resolves.toBeNull();
  });

  it('returns null when no capable engine exists or the engine fails', async () => {
    const none = makeTitleService({ provider: null });
    await expect(none.service.generateBranchSlug('anything')).resolves.toBeNull();
    const failing = makeTitleService({ completion: new Error('down') });
    await expect(failing.service.generateBranchSlug('anything')).resolves.toBeNull();
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
