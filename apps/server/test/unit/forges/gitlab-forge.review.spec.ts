import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitlabForgeProvider } from '../../../src/forges/providers/gitlab-forge.provider';
import { SettingsModule } from '../../../src/settings/settings.module';

type FetchCall = { url: string; init?: RequestInit };

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

const MR_ITEM = {
  iid: 3,
  title: 'Fix pipeline',
  state: 'opened',
  draft: true,
  author: { username: 'oscar' },
  source_branch: 'nuncio/xyz-fix',
  target_branch: 'main',
  web_url: 'https://gitlab.com/octo/repo/-/merge_requests/3',
  updated_at: '2026-07-02T07:00:00Z',
  user_notes_count: 4,
};

describe('GitlabForgeProvider — review/merge/issues surface', () => {
  let module: TestingModule;
  let provider: GitlabForgeProvider;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-gitlab-review-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

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
    delete process.env.GITLAB_TOKEN;
  });

  beforeEach(() => {
    process.env.GITLAB_TOKEN = 'glpat_test_token';
    provider.fetchOverride = undefined;
    provider.cliTokenOverride = async () => null;
    provider.bustCache();
  });

  const repo = { owner: 'octo', repo: 'repo' };

  it('declares GitLab capabilities (no request-changes, no rebase merge)', () => {
    expect(provider.capabilities()).toEqual({
      requestChanges: false,
      rebaseMerge: false,
      mergeWhenChecksPass: true,
      resolveThreads: true,
      updateBranch: true,
      rerunFailedOnly: false,
    });
  });

  it('listPullRequests maps opened → open and keeps the notes count', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      { match: (url) => url.includes('/merge_requests?'), body: [MR_ITEM] },
    ]);
    provider.fetchOverride = fetchOverride;

    const pulls = await provider.listPullRequests(repo, 'open');

    expect(calls[0].url).toBe(
      'https://gitlab.com/api/v4/projects/octo%2Frepo/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=50',
    );
    expect(pulls[0]).toEqual({
      number: 3,
      title: 'Fix pipeline',
      state: 'open',
      draft: true,
      author: 'oscar',
      sourceBranch: 'nuncio/xyz-fix',
      targetBranch: 'main',
      url: 'https://gitlab.com/octo/repo/-/merge_requests/3',
      updatedAt: '2026-07-02T07:00:00Z',
      commentCount: 4,
    });
  });

  it('getPullRequestDetail combines MR detail with the approvals state', async () => {
    const { fetchOverride } = makeRoutedFetch([
      { match: (url) => url.endsWith('/approvals'), body: { approved: true } },
      {
        match: (url) => url.endsWith('/merge_requests/3'),
        body: {
          ...MR_ITEM,
          description: 'MR body',
          detailed_merge_status: 'need_rebase',
          changes_count: '7',
        },
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const detail = await provider.getPullRequestDetail(repo, 3);

    expect(detail.body).toBe('MR body');
    expect(detail.mergeable).toBe('behind');
    expect(detail.reviewDecision).toBe('approved');
    expect(detail.changedFiles).toBe(7);
  });

  it('maps has_conflicts and blocked detailed statuses', async () => {
    const { fetchOverride } = makeRoutedFetch([
      { match: (url) => url.endsWith('/approvals'), body: { approved: false } },
      {
        match: (url) => url.endsWith('/merge_requests/3'),
        body: { ...MR_ITEM, has_conflicts: true, detailed_merge_status: 'mergeable' },
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const detail = await provider.getPullRequestDetail(repo, 3);
    expect(detail.mergeable).toBe('conflicts');
  });

  it('listPullRequestFiles counts additions/deletions from the diff text', async () => {
    const { fetchOverride } = makeRoutedFetch([
      {
        match: (url) => url.includes('/diffs'),
        body: [
          {
            old_path: 'a.ts',
            new_path: 'a.ts',
            diff: '@@ -1,2 +1,3 @@\n-old line\n+new line\n+another line\n context',
          },
          { old_path: 'bin.png', new_path: 'bin.png', new_file: true, diff: '' },
        ],
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const files = await provider.listPullRequestFiles(repo, 3);

    expect(files[0]).toMatchObject({ path: 'a.ts', additions: 2, deletions: 1, status: 'modified' });
    expect(files[1]).toMatchObject({ path: 'bin.png', status: 'added', patch: null });
  });

  it('listReviewThreads keeps real discussions and drops individual notes + system notes', async () => {
    const { fetchOverride } = makeRoutedFetch([
      {
        match: (url) => url.includes('/discussions'),
        body: [
          {
            id: 'disc1',
            individual_note: false,
            notes: [
              {
                id: 501,
                body: 'please rename',
                author: { username: 'reviewer' },
                created_at: '2026-07-02T06:00:00Z',
                resolvable: true,
                resolved: false,
                position: { new_path: 'src/x.ts', new_line: 8 },
              },
              { id: 502, body: 'changed the milestone', system: true },
            ],
          },
          { id: 'disc2', individual_note: true, notes: [{ id: 600, body: 'plain comment' }] },
        ],
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const threads = await provider.listReviewThreads(repo, 3);

    expect(threads).toHaveLength(1);
    expect(threads[0]).toEqual({
      id: 'disc1',
      replyTargetId: 'disc1',
      resolved: false,
      resolvable: true,
      path: 'src/x.ts',
      line: 8,
      outdated: false,
      comments: [
        { id: '501', author: 'reviewer', body: 'please rename', createdAt: '2026-07-02T06:00:00Z' },
      ],
    });
  });

  it('replyToThread and resolveThread hit the discussions endpoints with the MR iid', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([{ match: () => true, body: {} }]);
    provider.fetchOverride = fetchOverride;

    await provider.replyToThread(repo, 3, 'disc1', 'done');
    await provider.resolveThread(repo, 3, 'disc1', true);

    expect(calls[0].url).toBe(
      'https://gitlab.com/api/v4/projects/octo%2Frepo/merge_requests/3/discussions/disc1/notes',
    );
    expect(calls[1].url).toBe(
      'https://gitlab.com/api/v4/projects/octo%2Frepo/merge_requests/3/discussions/disc1?resolved=true',
    );
    expect(calls[1].init?.method).toBe('PUT');
  });

  it('submitReview approves via the approve endpoint and rejects request_changes', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([{ match: () => true, body: {} }]);
    provider.fetchOverride = fetchOverride;

    await provider.submitReview(repo, 3, { event: 'approve' });
    expect(calls[0].url).toContain('/merge_requests/3/approve');

    await expect(provider.submitReview(repo, 3, { event: 'request_changes', body: 'x' })).rejects.toThrow(
      'request-changes',
    );
  });

  it('mergePullRequest maps squash + delete flags and rejects rebase', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      { match: (url) => url.endsWith('/merge'), body: { state: 'merged', merge_commit_sha: 'sha9' } },
    ]);
    provider.fetchOverride = fetchOverride;

    const result = await provider.mergePullRequest(repo, 3, {
      method: 'squash',
      deleteSourceBranch: true,
    });

    expect(result).toEqual({ merged: true, sha: 'sha9', message: '' });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      squash: true,
      should_remove_source_branch: true,
    });

    await expect(provider.mergePullRequest(repo, 3, { method: 'rebase' })).rejects.toThrow('rebase');
  });

  it('issue notes use the issues endpoint, not the MR notes endpoint', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([{ match: () => true, body: {} }]);
    provider.fetchOverride = fetchOverride;

    await provider.addIssueComment(repo, 12, 'issue note');

    expect(calls[0].url).toBe('https://gitlab.com/api/v4/projects/octo%2Frepo/issues/12/notes');
  });

  it('getIssue filters system notes and normalizes the state', async () => {
    const { fetchOverride } = makeRoutedFetch([
      {
        match: (url) => url.includes('/notes'),
        body: [
          { id: 1, body: 'real note', author: { username: 'o' }, created_at: 't' },
          { id: 2, body: 'status changed', system: true },
        ],
      },
      {
        match: (url) => url.endsWith('/issues/12'),
        body: {
          iid: 12,
          title: 'Crash',
          state: 'opened',
          description: 'boom',
          labels: ['bug'],
          web_url: 'u',
        },
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const issue = await provider.getIssue(repo, 12);

    expect(issue.state).toBe('open');
    expect(issue.body).toBe('boom');
    expect(issue.comments).toHaveLength(1);
  });

  it('createIssue joins labels into GitLab csv form', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      { match: () => true, body: { iid: 13, title: 'New', state: 'opened', web_url: 'u' } },
    ]);
    provider.fetchOverride = fetchOverride;

    const issue = await provider.createIssue(repo, { title: 'New', body: 'B', labels: ['a', 'b'] });

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      title: 'New',
      description: 'B',
      labels: 'a,b',
    });
    expect(issue.number).toBe(13);
  });
});
