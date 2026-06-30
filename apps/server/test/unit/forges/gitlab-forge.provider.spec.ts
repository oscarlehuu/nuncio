import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitlabForgeProvider } from '../../../src/forges/providers/gitlab-forge.provider';
import { SettingsModule } from '../../../src/settings/settings.module';

type FetchCall = { url: string; init?: RequestInit };

/**
 * Captures every call into the provider's `fetchOverride` hook and returns a
 * canned JSON body shaped like a real GitLab `GET /user` response.
 */
function makeFetchStub(body: unknown = { username: 'tanuki', name: 'GitLab Tanuki' }) {
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

describe('GitlabForgeProvider', () => {
  let module: TestingModule;
  let provider: GitlabForgeProvider;
  let dataDir: string;
  let previousToken: string | undefined;
  let previousApiUrl: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-gitlab-forge-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    previousToken = process.env.GITLAB_TOKEN;
    previousApiUrl = process.env.GITLAB_API_URL;

    module = await Test.createTestingModule({
      imports: [SettingsModule],
      providers: [GitlabForgeProvider],
    }).compile();

    provider = module.get(GitlabForgeProvider);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
    if (previousApiUrl === undefined) delete process.env.GITLAB_API_URL;
    else process.env.GITLAB_API_URL = previousApiUrl;
  });

  beforeEach(() => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_API_URL;
    provider.fetchOverride = undefined;
    provider.cliTokenOverride = async () => null;
    provider.bustCache();
  });

  it('exposes a stable id and name', () => {
    expect(provider.id).toBe('gitlab');
    expect(provider.name).toBe('GitLab');
  });

  it('isAvailable returns false when GITLAB_TOKEN is missing', async () => {
    expect(await provider.isAvailable()).toBe(false);
  });

  it('isAvailable returns true when GITLAB_TOKEN is set', async () => {
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    expect(await provider.isAvailable()).toBe(true);
    expect(await provider.resolveAuth()).toEqual({ token: 'glpat-test-token', method: 'token' });
  });

  it('uses the glab CLI token when GITLAB_TOKEN is missing', async () => {
    provider.cliTokenOverride = async () => 'glpat-cli-token';
    const { fetchOverride, calls } = makeFetchStub();
    provider.fetchOverride = fetchOverride;

    expect(await provider.isAvailable()).toBe(true);
    expect(await provider.resolveAuth()).toEqual({ token: 'glpat-cli-token', method: 'cli' });

    await provider.getCurrentUser();
    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer glpat-cli-token');
  });

  it('prefers GITLAB_TOKEN over the glab CLI token', async () => {
    process.env.GITLAB_TOKEN = 'glpat-pat-token';
    provider.cliTokenOverride = async () => 'glpat-cli-token';
    const { fetchOverride, calls } = makeFetchStub();
    provider.fetchOverride = fetchOverride;

    expect(await provider.resolveAuth()).toEqual({ token: 'glpat-pat-token', method: 'token' });
    await provider.getCurrentUser();

    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer glpat-pat-token');
  });

  it('isAvailable caches the result until bustCache', async () => {
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    expect(await provider.isAvailable()).toBe(true);
    delete process.env.GITLAB_TOKEN;
    // Still cached.
    expect(await provider.isAvailable()).toBe(true);
    provider.bustCache();
    expect(await provider.isAvailable()).toBe(false);
  });

  it('getCurrentUser GETs <base>/user with a Bearer auth header and maps username to login', async () => {
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const { fetchOverride, calls } = makeFetchStub();
    provider.fetchOverride = fetchOverride;

    const user = await provider.getCurrentUser();

    expect(user).toEqual({ login: 'tanuki', name: 'GitLab Tanuki' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://gitlab.com/api/v4/user');
    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer glpat-test-token');
  });

  it('getCurrentUser returns name as null when GitLab omits it', async () => {
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const { fetchOverride } = makeFetchStub({ username: 'ghost', name: null });
    provider.fetchOverride = fetchOverride;

    expect(await provider.getCurrentUser()).toEqual({ login: 'ghost', name: null });
  });

  it('honours a self-hosted GITLAB_API_URL base (trailing slash stripped)', async () => {
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    process.env.GITLAB_API_URL = 'https://gitlab.acme.test/api/v4/';
    const { fetchOverride, calls } = makeFetchStub();
    provider.fetchOverride = fetchOverride;

    await provider.getCurrentUser();

    expect(calls[0].url).toBe('https://gitlab.acme.test/api/v4/user');
  });

  it('createPullRequest POSTs the MR payload to /projects/<enc>/merge_requests and maps iid/web_url', async () => {
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const { fetchOverride, calls } = makeFetchStub({
      iid: 42,
      web_url: 'https://gitlab.com/octo/repo/-/merge_requests/42',
      state: 'opened',
      title: 'Add a feature',
    });
    provider.fetchOverride = fetchOverride;

    const pr = await provider.createPullRequest(
      { owner: 'octo', repo: 'repo' },
      { title: 'Add a feature', body: 'Implements the thing', head: 'nuncio/x', base: 'main' },
    );

    expect(pr).toEqual({
      number: 42,
      url: 'https://gitlab.com/octo/repo/-/merge_requests/42',
      state: 'opened',
      title: 'Add a feature',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://gitlab.com/api/v4/projects/octo%2Frepo/merge_requests');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({
      source_branch: 'nuncio/x',
      target_branch: 'main',
      title: 'Add a feature',
      description: 'Implements the thing',
    });
    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer glpat-test-token');
  });

  it('getPullRequest GETs the merge_requests/{number} endpoint and maps the response', async () => {
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const { fetchOverride, calls } = makeFetchStub({
      iid: 7,
      web_url: 'https://gitlab.com/octo/repo/-/merge_requests/7',
      state: 'merged',
      title: 'Old MR',
    });
    provider.fetchOverride = fetchOverride;

    const pr = await provider.getPullRequest({ owner: 'octo', repo: 'repo' }, 7);

    expect(pr).toEqual({
      number: 7,
      url: 'https://gitlab.com/octo/repo/-/merge_requests/7',
      state: 'merged',
      title: 'Old MR',
    });
    expect(calls[0].url).toBe('https://gitlab.com/api/v4/projects/octo%2Frepo/merge_requests/7');
  });

  it('listChecks GETs the pipelines endpoint and maps each pipeline to a check', async () => {
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const { fetchOverride, calls } = makeFetchStub([
      { id: 101, status: 'success' },
      { id: 102, status: 'running' },
    ]);
    provider.fetchOverride = fetchOverride;

    const checks = await provider.listChecks({ owner: 'octo', repo: 'repo' }, 'feature/x');

    expect(checks).toEqual([
      { name: 'pipeline-101', status: 'success', conclusion: 'success' },
      { name: 'pipeline-102', status: 'running', conclusion: 'running' },
    ]);
    expect(calls[0].url).toBe(
      'https://gitlab.com/api/v4/projects/octo%2Frepo/pipelines?ref=feature%2Fx',
    );
  });

  it('addComment POSTs to the merge_requests/{number}/notes endpoint with the body', async () => {
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const { fetchOverride, calls } = makeFetchStub({ id: 1 });
    provider.fetchOverride = fetchOverride;

    await provider.addComment({ owner: 'octo', repo: 'repo' }, 42, 'looks good');

    expect(calls[0].url).toBe(
      'https://gitlab.com/api/v4/projects/octo%2Frepo/merge_requests/42/notes',
    );
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ body: 'looks good' });
  });
});

/**
 * Phase 5 — inbound webhook surface on the GitLab provider:
 * shared-secret token verification (x-gitlab-token) and payload→event mapping.
 */
describe('GitlabForgeProvider — webhooks (Phase 5)', () => {
  let module: TestingModule;
  let provider: GitlabForgeProvider;
  let dataDir: string;
  let previousSecret: string | undefined;

  const SECRET = 'gl-webhook-secret';
  const RAW_BODY = JSON.stringify({ object_kind: 'merge_request' });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-gitlab-webhook-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    previousSecret = process.env.GITLAB_WEBHOOK_SECRET;

    module = await Test.createTestingModule({
      imports: [SettingsModule],
      providers: [GitlabForgeProvider],
    }).compile();

    provider = module.get(GitlabForgeProvider);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    if (previousSecret === undefined) delete process.env.GITLAB_WEBHOOK_SECRET;
    else process.env.GITLAB_WEBHOOK_SECRET = previousSecret;
  });

  beforeEach(() => {
    delete process.env.GITLAB_WEBHOOK_SECRET;
  });

  describe('verifyWebhookSignature', () => {
    it('returns true when x-gitlab-token matches the configured secret', () => {
      process.env.GITLAB_WEBHOOK_SECRET = SECRET;
      expect(provider.verifyWebhookSignature({ 'x-gitlab-token': SECRET }, RAW_BODY)).toBe(true);
    });

    it('returns false when x-gitlab-token does not match', () => {
      process.env.GITLAB_WEBHOOK_SECRET = SECRET;
      expect(
        provider.verifyWebhookSignature({ 'x-gitlab-token': 'wrong-token' }, RAW_BODY),
      ).toBe(false);
    });

    it('returns false when the x-gitlab-token header is missing', () => {
      process.env.GITLAB_WEBHOOK_SECRET = SECRET;
      expect(provider.verifyWebhookSignature({}, RAW_BODY)).toBe(false);
    });

    it('fails closed (returns false) when no webhook secret is configured', () => {
      expect(provider.verifyWebhookSignature({ 'x-gitlab-token': SECRET }, RAW_BODY)).toBe(false);
    });
  });

  describe('parseWebhookEvent', () => {
    it('maps a Merge Request Hook with owner/repo split and labels', () => {
      const headers = {
        'x-gitlab-event': 'Merge Request Hook',
        'x-gitlab-event-uuid': 'delivery-mr-1',
      };
      const payload = {
        object_attributes: {
          iid: 34,
          title: 'Fix the bug',
          description: 'Patch incoming',
          action: 'open',
          target_branch: 'main',
        },
        project: {
          path_with_namespace: 'octo/nuncio',
          default_branch: 'develop',
        },
        labels: [{ title: 'bug' }, { title: 'urgent' }],
      };

      const event = provider.parseWebhookEvent(headers, payload);

      expect(event).toEqual({
        provider: 'gitlab',
        deliveryId: 'delivery-mr-1',
        kind: 'pull_request',
        action: 'opened',
        owner: 'octo',
        repo: 'nuncio',
        repoFullName: 'octo/nuncio',
        defaultBranch: 'develop',
        number: 34,
        title: 'Fix the bug',
        body: 'Patch incoming',
        labels: ['bug', 'urgent'],
      });
    });

    it('maps an Issue Hook with owner/repo split and labels', () => {
      const headers = {
        'x-gitlab-event': 'Issue Hook',
        'x-gitlab-event-uuid': 'delivery-issue-1',
      };
      const payload = {
        object_attributes: {
          iid: 12,
          title: 'Add a feature',
          description: 'Please add the thing',
          action: 'open',
          target_branch: '',
        },
        project: {
          path_with_namespace: 'group/sub/nuncio',
          default_branch: 'main',
        },
        labels: [{ title: 'enhancement' }],
      };

      const event = provider.parseWebhookEvent(headers, payload);

      expect(event).toEqual({
        provider: 'gitlab',
        deliveryId: 'delivery-issue-1',
        kind: 'issue',
        action: 'opened',
        owner: 'group/sub',
        repo: 'nuncio',
        repoFullName: 'group/sub/nuncio',
        defaultBranch: 'main',
        number: 12,
        title: 'Add a feature',
        body: 'Please add the thing',
        labels: ['enhancement'],
      });
    });

    it('returns null for an unrelated x-gitlab-event (e.g. Push Hook)', () => {
      const headers = { 'x-gitlab-event': 'Push Hook', 'x-gitlab-event-uuid': 'd' };
      expect(provider.parseWebhookEvent(headers, { object_attributes: {} })).toBeNull();
    });

    it('defaults deliveryId to empty string when the uuid header is absent', () => {
      const headers = { 'x-gitlab-event': 'Merge Request Hook' };
      const payload = {
        object_attributes: { iid: 1, title: 't', description: 'd', action: 'open', target_branch: 'main' },
        project: { path_with_namespace: 'octo/nuncio', default_branch: 'main' },
      };
      const event = provider.parseWebhookEvent(headers, payload);
      expect(event?.deliveryId).toBe('');
      expect(event?.labels).toEqual([]);
    });
  });
});
