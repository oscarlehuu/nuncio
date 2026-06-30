import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../../../src/db/database.module';
import { ForgesService } from '../../../src/forges/forges.service';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import type {
  CreatePullRequestOptions,
  ForgePullRequest,
  ForgeRepoRef,
} from '../../../src/forges/forges.types';

describe('ForgesService', () => {
  let module: TestingModule;
  let sessions: SessionsRepository;
  let service: ForgesService;
  let dataDir: string;

  let createCalls: Array<{ repo: ForgeRepoRef; opts: CreatePullRequestOptions }>;
  let stubProvider: {
    id: string;
    createPullRequest: (repo: ForgeRepoRef, opts: CreatePullRequestOptions) => Promise<ForgePullRequest>;
    getPullRequest: (repo: ForgeRepoRef, n: number) => Promise<ForgePullRequest>;
    listChecks: (repo: ForgeRepoRef, ref: string) => Promise<unknown[]>;
  };
  let registryStub: { getAvailable: (id: string) => Promise<typeof stubProvider>; get: (id: string) => typeof stubProvider };
  let gitStub: { remoteInfo: (path: string) => Promise<{ host: string; owner: string; repo: string }> };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-forges-service-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    createCalls = [];
    stubProvider = {
      id: 'github',
      createPullRequest: async (repo, opts) => {
        createCalls.push({ repo, opts });
        return {
          number: 99,
          url: 'https://github.com/octo/nuncio/pull/99',
          state: 'open',
          title: opts.title,
        };
      },
      getPullRequest: async () => ({
        number: 99,
        url: 'https://github.com/octo/nuncio/pull/99',
        state: 'open',
        title: 'PR',
      }),
      listChecks: async () => [{ name: 'build', status: 'completed', conclusion: 'success' }],
    };
    registryStub = {
      getAvailable: async () => stubProvider,
      get: () => stubProvider,
    };
    gitStub = {
      remoteInfo: async () => ({ host: 'github.com', owner: 'octo', repo: 'nuncio' }),
    };
    service = new ForgesService(registryStub as never, gitStub as never, sessions);
  });

  it('derives the title from the session title and the body from the prompt', async () => {
    const s = sessions.create({
      prompt: 'Implement the rate limiter so requests are throttled',
      projectPath: '/repo',
      branch: 'nuncio/abc-rate-limit',
      baseBranch: 'main',
    });

    const pr = await service.openPullRequestForSession(s.id);

    expect(pr.url).toBe('https://github.com/octo/nuncio/pull/99');
    expect(createCalls).toHaveLength(1);
    const { opts, repo } = createCalls[0];
    expect(repo).toEqual({ owner: 'octo', repo: 'nuncio' });
    expect(opts.head).toBe('nuncio/abc-rate-limit');
    expect(opts.base).toBe('main');
    expect(opts.title).toBe(s.title);
    expect(opts.body).toContain('Implement the rate limiter');
  });

  it('honours explicit title/body/base overrides', async () => {
    const s = sessions.create({
      prompt: 'do the thing',
      projectPath: '/repo',
      branch: 'nuncio/x',
      baseBranch: 'main',
    });

    await service.openPullRequestForSession(s.id, {
      title: 'Custom title',
      body: 'Custom body',
      base: 'develop',
      draft: true,
    });

    const { opts } = createCalls[0];
    expect(opts.title).toBe('Custom title');
    expect(opts.body).toBe('Custom body');
    expect(opts.base).toBe('develop');
    expect(opts.draft).toBe(true);
  });

  it('persists PR metadata onto the session via updateForgeState', async () => {
    const s = sessions.create({
      prompt: 'persist me',
      projectPath: '/repo',
      branch: 'nuncio/persist',
      baseBranch: 'main',
    });

    await service.openPullRequestForSession(s.id);

    const refreshed = sessions.findById(s.id)!;
    expect(refreshed.forgeProvider).toBe('github');
    expect(refreshed.pullRequestUrl).toBe('https://github.com/octo/nuncio/pull/99');
    expect(refreshed.pullRequestNumber).toBe(99);
    expect(refreshed.pullRequestState).toBe('open');
    expect(refreshed.forgeStatus).toBe('open');
  });

  it('rejects when the session has no branch', async () => {
    const s = sessions.create({ prompt: 'no branch here', projectPath: '/repo' });
    await expect(service.openPullRequestForSession(s.id)).rejects.toThrow(BadRequestException);
  });

  describe('listStatus', () => {
    it('returns status with login when provider is available and responds within timeout', async () => {
      const p1 = {
        id: 'github',
        name: 'GitHub',
        isAvailable: async () => true,
        resolveAuth: async () => ({ token: 'ghp_test', method: 'token' as const }),
        getCurrentUser: async () => ({ login: 'octocat', name: 'The Cat' }),
      };
      const p2 = {
        id: 'gitlab',
        name: 'GitLab',
        isAvailable: async () => false,
        resolveAuth: async () => null,
        getCurrentUser: async () => ({ login: 'tanuki', name: 'Tanuki' }),
      };
      const customRegistry = {
        all: () => [p1, p2],
      };
      const customService = new ForgesService(customRegistry as any, gitStub as any, sessions);
      const status = await customService.listStatus();
      expect(status).toHaveLength(2);
      expect(status[0]).toEqual({
        id: 'github',
        name: 'GitHub',
        connected: true,
        method: 'token',
        login: 'octocat',
      });
      expect(status[1]).toEqual({
        id: 'gitlab',
        name: 'GitLab',
        connected: false,
        method: null,
        login: null,
      });
    });

    it('reports cli auth method when resolveAuth returns a CLI token', async () => {
      const p1 = {
        id: 'github',
        name: 'GitHub',
        isAvailable: async () => true,
        resolveAuth: async () => ({ token: 'gho_cli', method: 'cli' as const }),
        getCurrentUser: async () => ({ login: 'octocat', name: null }),
      };
      const customRegistry = {
        all: () => [p1],
      };
      const customService = new ForgesService(customRegistry as any, gitStub as any, sessions);
      const status = await customService.listStatus();
      expect(status[0]).toEqual({
        id: 'github',
        name: 'GitHub',
        connected: true,
        method: 'cli',
        login: 'octocat',
      });
    });

    it('returns login as null if getCurrentUser throws', async () => {
      const p1 = {
        id: 'github',
        name: 'GitHub',
        isAvailable: async () => true,
        resolveAuth: async () => ({ token: 'ghp_test', method: 'token' as const }),
        getCurrentUser: async () => { throw new Error('API down'); },
      };
      const customRegistry = {
        all: () => [p1],
      };
      const customService = new ForgesService(customRegistry as any, gitStub as any, sessions);
      const status = await customService.listStatus();
      expect(status[0].login).toBeNull();
    });

    it('returns login as null if getCurrentUser times out', async () => {
      const p1 = {
        id: 'github',
        name: 'GitHub',
        isAvailable: async () => true,
        resolveAuth: async () => ({ token: 'ghp_test', method: 'token' as const }),
        getCurrentUser: () => new Promise<any>((resolve) => setTimeout(() => resolve({ login: 'octocat' }), 5000)),
      };
      const customRegistry = {
        all: () => [p1],
      };
      const customService = new ForgesService(customRegistry as any, gitStub as any, sessions);
      
      const start = Date.now();
      const status = await customService.listStatus();
      const duration = Date.now() - start;
      
      expect(duration).toBeLessThan(3500); // Should resolve quickly because of the 2.5s timeout
      expect(status[0].login).toBeNull();
    });
  });
});
