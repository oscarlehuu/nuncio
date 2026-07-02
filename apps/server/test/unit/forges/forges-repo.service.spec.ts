import { BadRequestException } from '@nestjs/common';
import { ForgeRepoService } from '../../../src/forges/forges-repo.service';
import type { ForgeRegistry } from '../../../src/forges/forges.registry';
import type { GitService } from '../../../src/git/git.service';
import type { ForgeProvider } from '../../../src/forges/forges.types';

function makeProvider(overrides: Partial<ForgeProvider> = {}): ForgeProvider {
  return {
    id: 'github',
    name: 'GitHub',
    isAvailable: async () => true,
    resolveAuth: async () => ({ token: 't', method: 'cli' as const }),
    capabilities: () => ({
      requestChanges: true,
      rebaseMerge: true,
      mergeWhenChecksPass: false,
      resolveThreads: true,
      updateBranch: true,
    }),
    listPullRequests: async () => [],
    getPullRequestDetail: async () => ({
      number: 1,
      url: 'u',
      state: 'open',
      title: 't',
      body: '',
      author: 'a',
      draft: false,
      sourceBranch: 'feature',
      targetBranch: 'main',
      mergeable: 'mergeable' as const,
      reviewDecision: null,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    }),
    listChecks: async () => [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    ...overrides,
  } as ForgeProvider;
}

function makeService(provider: ForgeProvider, host = 'github.com') {
  const git = {
    remoteInfo: async (path: string) => {
      if (!path.startsWith('/')) throw new BadRequestException('not a repo');
      return { host, owner: 'octo', repo: 'repo' };
    },
  } as unknown as GitService;
  const registry = {
    get: (id: string) => {
      if (id !== provider.id) throw new BadRequestException(`Unknown forge provider ${id}`);
      return provider;
    },
    getAvailable: async (id: string) => {
      if (id !== provider.id) throw new BadRequestException(`provider ${id} not available`);
      return provider;
    },
  } as unknown as ForgeRegistry;
  return new ForgeRepoService(registry, git);
}

describe('ForgeRepoService', () => {
  it('rejects a missing path with a 400', async () => {
    const service = makeService(makeProvider());
    await expect(service.listPullRequests('', 'open')).rejects.toThrow('path query parameter');
    await expect(service.capabilities('  ')).rejects.toThrow('path query parameter');
  });

  it('capabilities reports connected + authMethod without requiring availability', async () => {
    const service = makeService(makeProvider());
    const caps = await service.capabilities('/some/repo');
    expect(caps).toMatchObject({
      provider: 'github',
      connected: true,
      authMethod: 'cli',
      requestChanges: true,
    });
  });

  it('capabilities reports connected:false when no auth resolves', async () => {
    const service = makeService(makeProvider({ resolveAuth: async () => null }));
    const caps = await service.capabilities('/some/repo');
    expect(caps.connected).toBe(false);
    expect(caps.authMethod).toBeNull();
  });

  it('routes gitlab-hosted repos to the gitlab provider id', async () => {
    const provider = makeProvider({ id: 'gitlab', name: 'GitLab' } as Partial<ForgeProvider>);
    const service = makeService(provider, 'gitlab.acme.dev');
    const caps = await service.capabilities('/some/repo');
    expect(caps.provider).toBe('gitlab');
  });

  it('getPullRequestDetail attaches checks for the source branch', async () => {
    const service = makeService(makeProvider());
    const detail = await service.getPullRequestDetail('/some/repo', 1);
    expect(detail.checks).toEqual([{ name: 'ci', status: 'completed', conclusion: 'success' }]);
  });

  it('rejects empty bodies on comment-like operations', async () => {
    const service = makeService(makeProvider());
    await expect(service.addIssueComment('/some/repo', 1, '  ')).rejects.toThrow('body is required');
    await expect(service.createIssue('/some/repo', { title: ' ', body: '' })).rejects.toThrow(
      'title is required',
    );
  });
});
