import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GithubForgeProvider } from '../../../src/forges/providers/github-forge.provider';
import { SettingsModule } from '../../../src/settings/settings.module';

type FetchCall = { url: string; init?: RequestInit };

/**
 * Captures every call into the provider's `fetchOverride` hook (the forge
 * analogue of CursorAgentProvider.sdkOverride) and returns a canned JSON body
 * shaped like a real GitHub `GET /user` response.
 */
function makeFetchStub(body: unknown = { login: 'octocat', name: 'The Octocat' }) {
  const calls: FetchCall[] = [];
  const fetchOverride = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchOverride, calls };
}

describe('GithubForgeProvider', () => {
  let module: TestingModule;
  let provider: GithubForgeProvider;
  let dataDir: string;
  let previousToken: string | undefined;
  let previousApiUrl: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-github-forge-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    previousToken = process.env.GITHUB_TOKEN;
    previousApiUrl = process.env.GITHUB_API_URL;

    module = await Test.createTestingModule({
      imports: [SettingsModule],
      providers: [GithubForgeProvider],
    }).compile();

    provider = module.get(GithubForgeProvider);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    if (previousApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = previousApiUrl;
  });

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_API_URL;
    provider.fetchOverride = undefined;
    provider.cliTokenOverride = async () => null;
    provider.bustCache();
  });

  it('exposes a stable id and name', () => {
    expect(provider.id).toBe('github');
    expect(provider.name).toBe('GitHub');
  });

  it('isAvailable returns false when GITHUB_TOKEN is missing', async () => {
    expect(await provider.isAvailable()).toBe(false);
  });

  it('isAvailable returns true when GITHUB_TOKEN is set', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    expect(await provider.isAvailable()).toBe(true);
    expect(await provider.resolveAuth()).toEqual({ token: 'ghp_test_token', method: 'token' });
  });

  it('uses the gh CLI token when GITHUB_TOKEN is missing', async () => {
    provider.cliTokenOverride = async () => 'gho_cli_token';
    const { fetchOverride, calls } = makeFetchStub();
    provider.fetchOverride = fetchOverride;

    expect(await provider.isAvailable()).toBe(true);
    expect(await provider.resolveAuth()).toEqual({ token: 'gho_cli_token', method: 'cli' });

    await provider.getCurrentUser();
    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer gho_cli_token');
  });

  it('prefers GITHUB_TOKEN over the gh CLI token', async () => {
    process.env.GITHUB_TOKEN = 'ghp_pat_token';
    provider.cliTokenOverride = async () => 'gho_cli_token';
    const { fetchOverride, calls } = makeFetchStub();
    provider.fetchOverride = fetchOverride;

    expect(await provider.resolveAuth()).toEqual({ token: 'ghp_pat_token', method: 'token' });
    await provider.getCurrentUser();

    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer ghp_pat_token');
  });

  it('isAvailable caches the result until bustCache', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    expect(await provider.isAvailable()).toBe(true);
    delete process.env.GITHUB_TOKEN;
    // Still cached.
    expect(await provider.isAvailable()).toBe(true);
    provider.bustCache();
    expect(await provider.isAvailable()).toBe(false);
  });

  it('getCurrentUser GETs <base>/user with a Bearer token and Accept header', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const { fetchOverride, calls } = makeFetchStub();
    provider.fetchOverride = fetchOverride;

    const user = await provider.getCurrentUser();

    expect(user).toEqual({ login: 'octocat', name: 'The Octocat' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/user');
    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer ghp_test_token');
    expect(headers.get('Accept')).toBe('application/vnd.github+json');
  });

  it('getCurrentUser returns name as null when GitHub omits it', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const { fetchOverride } = makeFetchStub({ login: 'ghost', name: null });
    provider.fetchOverride = fetchOverride;

    expect(await provider.getCurrentUser()).toEqual({ login: 'ghost', name: null });
  });

  it('honours GITHUB_API_URL for GitHub Enterprise base URLs', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.GITHUB_API_URL = 'https://github.acme.test/api/v3';
    const { fetchOverride, calls } = makeFetchStub();
    provider.fetchOverride = fetchOverride;

    await provider.getCurrentUser();

    expect(calls[0].url).toBe('https://github.acme.test/api/v3/user');
  });

  it('createPullRequest POSTs to the pulls endpoint with the PR payload and maps html_url to url', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const { fetchOverride, calls } = makeFetchStub({
      number: 42,
      html_url: 'https://github.com/octo/repo/pull/42',
      state: 'open',
      title: 'Add a feature',
    });
    provider.fetchOverride = fetchOverride;

    const pr = await provider.createPullRequest(
      { owner: 'octo', repo: 'repo' },
      { title: 'Add a feature', body: 'Implements the thing', head: 'nuncio/x', base: 'main', draft: true },
    );

    expect(pr).toEqual({
      number: 42,
      url: 'https://github.com/octo/repo/pull/42',
      state: 'open',
      title: 'Add a feature',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/octo/repo/pulls');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({
      title: 'Add a feature',
      body: 'Implements the thing',
      head: 'nuncio/x',
      base: 'main',
      draft: true,
    });
    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer ghp_test_token');
  });

  it('getPullRequest GETs the pulls/{number} endpoint and maps the response', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const { fetchOverride, calls } = makeFetchStub({
      number: 7,
      html_url: 'https://github.com/octo/repo/pull/7',
      state: 'closed',
      title: 'Old PR',
    });
    provider.fetchOverride = fetchOverride;

    const pr = await provider.getPullRequest({ owner: 'octo', repo: 'repo' }, 7);

    expect(pr).toEqual({
      number: 7,
      url: 'https://github.com/octo/repo/pull/7',
      state: 'closed',
      title: 'Old PR',
    });
    expect(calls[0].url).toBe('https://api.github.com/repos/octo/repo/pulls/7');
  });

  it('listChecks GETs the commits/{ref}/check-runs endpoint and maps check_runs', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const { fetchOverride, calls } = makeFetchStub({
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'lint', status: 'in_progress', conclusion: null },
      ],
    });
    provider.fetchOverride = fetchOverride;

    const checks = await provider.listChecks({ owner: 'octo', repo: 'repo' }, 'deadbeef');

    expect(checks).toEqual([
      { name: 'build', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'in_progress', conclusion: null },
    ]);
    expect(calls[0].url).toBe('https://api.github.com/repos/octo/repo/commits/deadbeef/check-runs');
  });

  it('addComment POSTs to the issues/{number}/comments endpoint with the body', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const { fetchOverride, calls } = makeFetchStub({ id: 1 });
    provider.fetchOverride = fetchOverride;

    await provider.addComment({ owner: 'octo', repo: 'repo' }, 42, 'looks good');

    expect(calls[0].url).toBe('https://api.github.com/repos/octo/repo/issues/42/comments');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ body: 'looks good' });
  });
});

import { createHmac } from 'node:crypto';

/**
 * Phase 4 — inbound webhook surface on the provider:
 * signature verification (HMAC-SHA256 over the raw body) and payload→event mapping.
 */
describe('GithubForgeProvider — webhooks (Phase 4)', () => {
  let module: TestingModule;
  let provider: GithubForgeProvider;
  let dataDir: string;
  let previousSecret: string | undefined;

  const SECRET = 'sh-webhook-secret';
  const RAW_BODY = JSON.stringify({ action: 'opened', hello: 'world' });

  function sign(body: string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-github-webhook-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    previousSecret = process.env.GITHUB_WEBHOOK_SECRET;

    module = await Test.createTestingModule({
      imports: [SettingsModule],
      providers: [GithubForgeProvider],
    }).compile();

    provider = module.get(GithubForgeProvider);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    if (previousSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
  });

  beforeEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  describe('verifyWebhookSignature', () => {
    it('returns true for a correctly signed raw body', () => {
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
      const headers = { 'x-hub-signature-256': sign(RAW_BODY, SECRET) };
      expect(provider.verifyWebhookSignature(headers, RAW_BODY)).toBe(true);
    });

    it('returns false when the body has been tampered with', () => {
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
      const headers = { 'x-hub-signature-256': sign(RAW_BODY, SECRET) };
      expect(provider.verifyWebhookSignature(headers, `${RAW_BODY} tampered`)).toBe(false);
    });

    it('returns false for a wrong / mismatched signature', () => {
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
      const headers = { 'x-hub-signature-256': sign(RAW_BODY, 'a-different-secret') };
      expect(provider.verifyWebhookSignature(headers, RAW_BODY)).toBe(false);
    });

    it('returns false when the signature header is missing', () => {
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
      expect(provider.verifyWebhookSignature({}, RAW_BODY)).toBe(false);
    });

    it('fails closed (returns false) when no webhook secret is configured', () => {
      const headers = { 'x-hub-signature-256': sign(RAW_BODY, SECRET) };
      expect(provider.verifyWebhookSignature(headers, RAW_BODY)).toBe(false);
    });
  });

  describe('parseWebhookEvent', () => {
    it('maps an issues event with all fields including labels', () => {
      const headers = {
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-issue-1',
      };
      const payload = {
        action: 'opened',
        issue: {
          number: 12,
          title: 'Add a feature',
          body: 'Please add the thing',
          labels: [{ name: 'nuncio' }, { name: 'enhancement' }],
        },
        repository: {
          name: 'nuncio',
          full_name: 'octo/nuncio',
          default_branch: 'main',
          owner: { login: 'octo' },
        },
      };

      const event = provider.parseWebhookEvent(headers, payload);

      expect(event).toEqual({
        provider: 'github',
        deliveryId: 'delivery-issue-1',
        kind: 'issue',
        action: 'opened',
        owner: 'octo',
        repo: 'nuncio',
        repoFullName: 'octo/nuncio',
        defaultBranch: 'main',
        number: 12,
        title: 'Add a feature',
        body: 'Please add the thing',
        labels: ['nuncio', 'enhancement'],
      });
    });

    it('maps a pull_request event with its fields and labels', () => {
      const headers = {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-pr-1',
      };
      const payload = {
        action: 'opened',
        pull_request: {
          number: 34,
          title: 'Fix the bug',
          body: 'Patch incoming',
          labels: [{ name: 'bug' }],
        },
        repository: {
          name: 'nuncio',
          full_name: 'octo/nuncio',
          default_branch: 'develop',
          owner: { login: 'octo' },
        },
      };

      const event = provider.parseWebhookEvent(headers, payload);

      expect(event).toEqual({
        provider: 'github',
        deliveryId: 'delivery-pr-1',
        kind: 'pull_request',
        action: 'opened',
        owner: 'octo',
        repo: 'nuncio',
        repoFullName: 'octo/nuncio',
        defaultBranch: 'develop',
        number: 34,
        title: 'Fix the bug',
        body: 'Patch incoming',
        labels: ['bug'],
      });
    });

    it('returns null for an unrelated x-github-event (e.g. ping)', () => {
      const headers = { 'x-github-event': 'ping', 'x-github-delivery': 'd' };
      expect(provider.parseWebhookEvent(headers, { zen: 'hi' })).toBeNull();
    });
  });
});
