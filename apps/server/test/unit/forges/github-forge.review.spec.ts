import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GithubForgeProvider } from '../../../src/forges/providers/github-forge.provider';
import { SettingsModule } from '../../../src/settings/settings.module';

type FetchCall = { url: string; init?: RequestInit };

/** Routes each URL (+method) to a canned JSON body so multi-request methods can be tested. */
function makeRoutedFetch(routes: Array<{ match: (url: string, method: string) => boolean; body: unknown }>) {
  const calls: FetchCall[] = [];
  const fetchOverride = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const method = init?.method ?? 'GET';
    const route = routes.find((r) => r.match(url, method));
    return {
      ok: true,
      status: 200,
      json: async () => route?.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchOverride, calls };
}

const PULL_LIST_ITEM = {
  number: 5,
  title: 'Improve things',
  state: 'closed',
  draft: false,
  merged_at: '2026-07-01T10:00:00Z',
  user: { login: 'oscar' },
  head: { ref: 'nuncio/abc-improve' },
  base: { ref: 'main' },
  html_url: 'https://github.com/octo/repo/pull/5',
  updated_at: '2026-07-01T10:00:00Z',
};

const THREADS_GRAPHQL = {
  data: {
    repository: {
      pullRequest: {
        reviewDecision: 'CHANGES_REQUESTED',
        reviewThreads: {
          nodes: [
            {
              id: 'PRT_node1',
              isResolved: false,
              isOutdated: true,
              path: 'src/app.ts',
              line: 12,
              comments: {
                nodes: [
                  {
                    databaseId: 111,
                    author: { login: 'reviewer' },
                    body: 'rename this',
                    createdAt: '2026-07-01T09:00:00Z',
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
};

describe('GithubForgeProvider — review/merge/issues surface', () => {
  let module: TestingModule;
  let provider: GithubForgeProvider;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-github-review-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

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
    delete process.env.GITHUB_TOKEN;
  });

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    provider.fetchOverride = undefined;
    provider.cliTokenOverride = async () => null;
    provider.bustCache();
  });

  const repo = { owner: 'octo', repo: 'repo' };

  it('declares GitHub capabilities', () => {
    expect(provider.capabilities()).toEqual({
      requestChanges: true,
      rebaseMerge: true,
      mergeWhenChecksPass: false,
      resolveThreads: true,
      updateBranch: true,
      rerunFailedOnly: true,
      listRepositories: true,
    });
  });

  it('listPullRequests maps summaries and marks merged PRs', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      { match: (url) => url.includes('/pulls?'), body: [PULL_LIST_ITEM] },
    ]);
    provider.fetchOverride = fetchOverride;

    const pulls = await provider.listPullRequests(repo, 'all');

    expect(calls[0].url).toBe(
      'https://api.github.com/repos/octo/repo/pulls?state=all&sort=updated&direction=desc&per_page=50',
    );
    expect(pulls).toEqual([
      {
        number: 5,
        title: 'Improve things',
        state: 'merged',
        draft: false,
        author: 'oscar',
        sourceBranch: 'nuncio/abc-improve',
        targetBranch: 'main',
        url: 'https://github.com/octo/repo/pull/5',
        updatedAt: '2026-07-01T10:00:00Z',
        commentCount: null,
      },
    ]);
  });

  it('getPullRequestDetail merges REST detail with the GraphQL review decision', async () => {
    const { fetchOverride } = makeRoutedFetch([
      { match: (url) => url.endsWith('/graphql'), body: THREADS_GRAPHQL },
      {
        match: (url) => url.endsWith('/pulls/5'),
        body: {
          ...PULL_LIST_ITEM,
          merged_at: null,
          state: 'open',
          body: 'PR description',
          mergeable_state: 'dirty',
          additions: 10,
          deletions: 2,
          changed_files: 3,
        },
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const detail = await provider.getPullRequestDetail(repo, 5);

    expect(detail.state).toBe('open');
    expect(detail.body).toBe('PR description');
    expect(detail.mergeable).toBe('conflicts');
    expect(detail.reviewDecision).toBe('changes_requested');
    expect(detail.additions).toBe(10);
    expect(detail.changedFiles).toBe(3);
  });

  it('listPullRequestFiles maps file statuses and keeps null patch for binaries', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      {
        match: (url) => url.includes('/files'),
        body: [
          { filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@' },
          { filename: 'img.png', status: 'added', additions: 0, deletions: 0 },
          { filename: 'b.ts', previous_filename: 'old-b.ts', status: 'renamed', additions: 0, deletions: 0, patch: '@@' },
        ],
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const files = await provider.listPullRequestFiles(repo, 5);

    expect(calls[0].url).toContain('/pulls/5/files?per_page=100');
    expect(files[0]).toEqual({
      path: 'a.ts',
      oldPath: null,
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@ -1 +1 @@',
    });
    expect(files[1].patch).toBeNull();
    expect(files[2]).toMatchObject({ path: 'b.ts', oldPath: 'old-b.ts', status: 'renamed' });
  });

  it('listReviewThreads maps GraphQL thread nodes with reply target from first comment', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      { match: (url) => url.endsWith('/graphql'), body: THREADS_GRAPHQL },
    ]);
    provider.fetchOverride = fetchOverride;

    const threads = await provider.listReviewThreads(repo, 5);

    expect(calls[0].url).toBe('https://api.github.com/graphql');
    const graphqlBody = JSON.parse(String(calls[0].init?.body));
    expect(graphqlBody.variables).toEqual({ owner: 'octo', repo: 'repo', number: 5 });
    expect(threads).toEqual([
      {
        id: 'PRT_node1',
        replyTargetId: '111',
        resolved: false,
        resolvable: true,
        path: 'src/app.ts',
        line: 12,
        outdated: true,
        comments: [
          { id: '111', author: 'reviewer', body: 'rename this', createdAt: '2026-07-01T09:00:00Z' },
        ],
      },
    ]);
  });

  it('replyToThread POSTs to the comment replies endpoint', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([{ match: () => true, body: {} }]);
    provider.fetchOverride = fetchOverride;

    await provider.replyToThread(repo, 5, '111', 'done');

    expect(calls[0].url).toBe('https://api.github.com/repos/octo/repo/pulls/5/comments/111/replies');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ body: 'done' });
  });

  it('resolveThread issues the resolve / unresolve GraphQL mutations', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      { match: (url) => url.endsWith('/graphql'), body: { data: { ok: true } } },
    ]);
    provider.fetchOverride = fetchOverride;

    await provider.resolveThread(repo, 5, 'PRT_node1', true);
    await provider.resolveThread(repo, 5, 'PRT_node1', false);

    expect(JSON.parse(String(calls[0].init?.body)).query).toContain('resolveReviewThread');
    expect(JSON.parse(String(calls[1].init?.body)).query).toContain('unresolveReviewThread');
  });

  it('submitReview maps events to GitHub review events', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([{ match: () => true, body: {} }]);
    provider.fetchOverride = fetchOverride;

    await provider.submitReview(repo, 5, { event: 'approve', body: 'ship it' });
    await provider.submitReview(repo, 5, { event: 'request_changes', body: 'not yet' });

    expect(calls[0].url).toContain('/pulls/5/reviews');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ event: 'APPROVE', body: 'ship it' });
    expect(JSON.parse(String(calls[1].init?.body)).event).toBe('REQUEST_CHANGES');
  });

  it('mergePullRequest PUTs the merge method and deletes the source branch when asked', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      { match: (url, method) => url.endsWith('/merge') && method === 'PUT', body: { merged: true, sha: 'abc123' } },
      { match: (url, method) => url.endsWith('/pulls/5') && method === 'GET', body: PULL_LIST_ITEM },
      { match: (_url, method) => method === 'DELETE', body: {} },
    ]);
    provider.fetchOverride = fetchOverride;

    const result = await provider.mergePullRequest(repo, 5, {
      method: 'squash',
      deleteSourceBranch: true,
      commitTitle: 'feat: improve',
    });

    expect(result).toEqual({ merged: true, sha: 'abc123', message: '' });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      merge_method: 'squash',
      commit_title: 'feat: improve',
    });
    const deleteCall = calls.find((c) => c.init?.method === 'DELETE');
    expect(deleteCall?.url).toBe(
      'https://api.github.com/repos/octo/repo/git/refs/heads/nuncio%2Fabc-improve',
    );
  });

  it('listIssues filters out pull requests from the issues feed', async () => {
    const { fetchOverride } = makeRoutedFetch([
      {
        match: (url) => url.includes('/issues?'),
        body: [
          {
            number: 9,
            title: 'Bug report',
            state: 'open',
            user: { login: 'someone' },
            labels: [{ name: 'bug' }],
            assignees: [{ login: 'oscar' }],
            comments: 2,
            updated_at: '2026-07-02T08:00:00Z',
            html_url: 'https://github.com/octo/repo/issues/9',
          },
          { number: 10, title: 'A PR', state: 'open', html_url: 'x', pull_request: {} },
        ],
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const issues = await provider.listIssues(repo, 'open');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 9,
      title: 'Bug report',
      state: 'open',
      author: 'someone',
      labels: ['bug'],
      assignees: ['oscar'],
      commentCount: 2,
      updatedAt: '2026-07-02T08:00:00Z',
      url: 'https://github.com/octo/repo/issues/9',
    });
  });

  it('getIssue combines the issue with its comments', async () => {
    const { fetchOverride } = makeRoutedFetch([
      {
        match: (url) => url.endsWith('/issues/9/comments?per_page=100'),
        body: [{ id: 77, user: { login: 'oscar' }, body: 'me too', created_at: '2026-07-02T09:00:00Z' }],
      },
      {
        match: (url) => url.endsWith('/issues/9'),
        body: {
          number: 9,
          title: 'Bug report',
          state: 'open',
          body: 'It broke',
          html_url: 'https://github.com/octo/repo/issues/9',
        },
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const issue = await provider.getIssue(repo, 9);

    expect(issue.body).toBe('It broke');
    expect(issue.comments).toEqual([
      { id: '77', author: 'oscar', body: 'me too', createdAt: '2026-07-02T09:00:00Z' },
    ]);
  });

  it('listPullRequestComments reads the issue comments feed for a pull', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      {
        match: (url) => url.endsWith('/issues/5/comments?per_page=100'),
        body: [
          {
            id: 101,
            user: { login: 'devin-ai-integration[bot]' },
            body: 'first note\n\n![shot](https://example.com/a.png)',
            created_at: '2026-07-19T12:00:00Z',
          },
          {
            id: 102,
            user: { login: 'oscar' },
            body: 'second note',
            created_at: '2026-07-19T13:00:00Z',
          },
        ],
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const comments = await provider.listPullRequestComments(repo, 5);

    expect(calls[0].url).toBe(
      'https://api.github.com/repos/octo/repo/issues/5/comments?per_page=100',
    );
    expect(comments).toEqual([
      {
        id: '101',
        author: 'devin-ai-integration[bot]',
        body: 'first note\n\n![shot](https://example.com/a.png)',
        createdAt: '2026-07-19T12:00:00Z',
      },
      {
        id: '102',
        author: 'oscar',
        body: 'second note',
        createdAt: '2026-07-19T13:00:00Z',
      },
    ]);
  });

  it('updateIssueState PATCHes the issue state and createIssue POSTs the payload', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      {
        match: (_url, method) => method === 'POST',
        body: { number: 11, title: 'New', state: 'open', html_url: 'u' },
      },
      { match: () => true, body: {} },
    ]);
    provider.fetchOverride = fetchOverride;

    await provider.updateIssueState(repo, 9, 'closed');
    const created = await provider.createIssue(repo, { title: 'New', body: 'B', labels: ['x'] });

    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ state: 'closed' });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ title: 'New', body: 'B', labels: ['x'] });
    expect(created.number).toBe(11);
  });
});
