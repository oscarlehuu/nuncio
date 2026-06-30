import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForgeRegistry } from '../../../src/forges/forges.registry';
import { ForgesModule } from '../../../src/forges/forges.module';

describe('ForgeRegistry', () => {
  let module: TestingModule;
  let dataDir: string;
  let previousToken: string | undefined;

  beforeAll(() => {
    previousToken = process.env.GITHUB_TOKEN;
  });

  afterEach(async () => {
    if (module) await module.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.GITHUB_TOKEN;
  });

  afterAll(() => {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  });

  async function createRegistry(): Promise<ForgeRegistry> {
    if (module) await module.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });

    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-forge-registry-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [ForgesModule],
    }).compile();

    const registry = module.get(ForgeRegistry);
    for (const provider of registry.all()) {
      (provider as any).cliTokenOverride = async () => null;
    }
    registry.bustCaches();
    return registry;
  }

  it('get returns the github provider by id', async () => {
    const registry = await createRegistry();
    expect(registry.get('github').id).toBe('github');
  });

  it('all() exposes every registered provider', async () => {
    const registry = await createRegistry();
    expect(registry.all().map((p) => p.id)).toEqual(['github', 'gitlab']);
  });

  it('rejects unknown providers via get', async () => {
    const registry = await createRegistry();
    expect(() => registry.get('nope')).toThrow(BadRequestException);
  });

  it('available() is empty when no GITHUB_TOKEN is set', async () => {
    delete process.env.GITHUB_TOKEN;
    const registry = await createRegistry();
    expect((await registry.available()).map((p) => p.id)).toEqual([]);
  });

  it('available() lists github when GITHUB_TOKEN is set', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const registry = await createRegistry();
    expect((await registry.available()).map((p) => p.id)).toEqual(['github']);
  });

  it('defaultId returns github when available', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const registry = await createRegistry();
    expect(await registry.defaultId()).toBe('github');
  });

  it('defaultId throws ServiceUnavailableException when nothing is configured', async () => {
    delete process.env.GITHUB_TOKEN;
    const registry = await createRegistry();
    await expect(registry.defaultId()).rejects.toThrow(ServiceUnavailableException);
  });

  it('getAvailable rejects an unavailable provider', async () => {
    delete process.env.GITHUB_TOKEN;
    const registry = await createRegistry();
    await expect(registry.getAvailable('github')).rejects.toThrow(BadRequestException);
  });

  it('bustCaches re-resolves a cached isAvailable after the token changes', async () => {
    delete process.env.GITHUB_TOKEN;
    const registry = await createRegistry();
    expect((await registry.available()).map((p) => p.id)).toEqual([]);

    process.env.GITHUB_TOKEN = 'ghp_test_token';
    // Still cached as unavailable until caches are busted.
    expect((await registry.available()).map((p) => p.id)).toEqual([]);

    registry.bustCaches();
    expect((await registry.available()).map((p) => p.id)).toEqual(['github']);
  });
});

describe('ForgeRegistry — GitLab (Phase 5)', () => {
  let module: TestingModule;
  let dataDir: string;
  let previousGithubToken: string | undefined;
  let previousGitlabToken: string | undefined;

  beforeAll(() => {
    previousGithubToken = process.env.GITHUB_TOKEN;
    previousGitlabToken = process.env.GITLAB_TOKEN;
  });

  afterEach(async () => {
    if (module) await module.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITLAB_TOKEN;
  });

  afterAll(() => {
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
    if (previousGitlabToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousGitlabToken;
  });

  async function createRegistry(): Promise<ForgeRegistry> {
    if (module) await module.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });

    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-forge-registry-gitlab-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [ForgesModule],
    }).compile();

    const registry = module.get(ForgeRegistry);
    for (const provider of registry.all()) {
      (provider as any).cliTokenOverride = async () => null;
    }
    registry.bustCaches();
    return registry;
  }

  it('get returns the gitlab provider by id', async () => {
    const registry = await createRegistry();
    expect(registry.get('gitlab').id).toBe('gitlab');
  });

  it('all() exposes both github and gitlab providers in order', async () => {
    const registry = await createRegistry();
    expect(registry.all().map((p) => p.id)).toEqual(['github', 'gitlab']);
  });

  it('available() includes both providers when both tokens are set', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const registry = await createRegistry();
    expect((await registry.available()).map((p) => p.id)).toEqual(['github', 'gitlab']);
  });

  it('available() lists only gitlab when only GITLAB_TOKEN is set', async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const registry = await createRegistry();
    expect((await registry.available()).map((p) => p.id)).toEqual(['gitlab']);
  });

  it('defaultId resolves to the first available provider (github) when both are set', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const registry = await createRegistry();
    expect(await registry.defaultId()).toBe('github');
  });

  it('defaultId resolves to gitlab when only GITLAB_TOKEN is set', async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const registry = await createRegistry();
    expect(await registry.defaultId()).toBe('gitlab');
  });
});
