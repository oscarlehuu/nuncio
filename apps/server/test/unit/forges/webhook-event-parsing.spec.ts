import { GithubForgeProvider } from '../../../src/forges/providers/github-forge.provider';
import { GitlabForgeProvider } from '../../../src/forges/providers/gitlab-forge.provider';
import { mapGithubPullDetail } from '../../../src/forges/providers/github-forge.mappers';
import { mapGitlabPullDetail } from '../../../src/forges/providers/gitlab-forge.mappers';

const settings = { resolve: () => undefined } as never;

const githubRepo = {
  name: 'nuncio',
  full_name: 'octo/nuncio',
  default_branch: 'main',
  owner: { login: 'octo' },
};

describe('forge webhook event parsing', () => {
  const github = new GithubForgeProvider(settings);
  const gitlab = new GitlabForgeProvider(settings);

  it('normalizes a submitted GitHub review with its author, state, body, and PR URL', () => {
    const event = github.parseWebhookEvent(
      { 'x-github-event': 'pull_request_review', 'x-github-delivery': 'review-1' },
      {
        action: 'submitted',
        review: { state: 'changes_requested', body: 'Please handle the race.', user: { login: 'reviewer' } },
        pull_request: { number: 42, html_url: 'https://github.com/octo/nuncio/pull/42' },
        repository: githubRepo,
      },
    );

    expect(event).toMatchObject({
      kind: 'pull_request_feedback',
      action: 'submitted',
      number: 42,
      author: 'reviewer',
      reviewState: 'changes_requested',
      comments: [{ body: 'Please handle the race.' }],
      url: 'https://github.com/octo/nuncio/pull/42',
    });
  });

  it('normalizes GitHub review comments with file and line context', () => {
    const event = github.parseWebhookEvent(
      { 'x-github-event': 'pull_request_review_comment', 'x-github-delivery': 'comment-1' },
      {
        action: 'created',
        comment: { body: 'This can be null.', path: 'src/a.ts', line: null, original_line: 19, user: { login: 'reviewer' } },
        pull_request: { number: 42, html_url: 'https://github.com/octo/nuncio/pull/42' },
        repository: githubRepo,
      },
    );

    expect(event).toMatchObject({
      kind: 'pull_request_feedback',
      number: 42,
      author: 'reviewer',
      comments: [{ body: 'This can be null.', path: 'src/a.ts', line: 19 }],
    });
  });

  it('normalizes GitHub issue comments only when the issue is a pull request', () => {
    const headers = { 'x-github-event': 'issue_comment', 'x-github-delivery': 'issue-comment-1' };
    const comment = { action: 'created', comment: { body: 'Follow up', user: { login: 'reviewer' } }, repository: githubRepo };

    expect(github.parseWebhookEvent(headers, { ...comment, issue: { number: 42 } })).toBeNull();
    expect(
      github.parseWebhookEvent(headers, {
        ...comment,
        issue: {
          number: 42,
          html_url: 'https://github.com/octo/nuncio/pull/42',
          pull_request: { url: 'https://api.github.com/repos/octo/nuncio/pulls/42' },
        },
      }),
    ).toMatchObject({ kind: 'pull_request_feedback', number: 42, author: 'reviewer' });
  });

  it('normalizes failed GitHub workflow and check runs associated with a PR', () => {
    const workflow = github.parseWebhookEvent(
      { 'x-github-event': 'workflow_run', 'x-github-delivery': 'workflow-1' },
      {
        action: 'completed',
        workflow_run: {
          id: 90,
          name: 'CI',
          conclusion: 'failure',
          html_url: 'https://github.com/octo/nuncio/actions/runs/90',
          pull_requests: [{ number: 42 }],
        },
        repository: githubRepo,
      },
    );
    const check = github.parseWebhookEvent(
      { 'x-github-event': 'check_run', 'x-github-delivery': 'check-1' },
      {
        action: 'completed',
        check_run: {
          id: 91,
          name: 'test',
          conclusion: 'failure',
          html_url: 'https://github.com/octo/nuncio/runs/91',
          pull_requests: [{ number: 42 }],
        },
        repository: githubRepo,
      },
    );

    expect(workflow).toMatchObject({ kind: 'ci_failure', number: 42, runId: 90, jobName: 'CI' });
    expect(check).toMatchObject({ kind: 'ci_failure', number: 42, jobName: 'test' });
    expect(check).not.toHaveProperty('jobId');
    expect(check).not.toHaveProperty('runId');
  });

  it('normalizes GitLab merge-request notes and failed associated pipelines', () => {
    const project = { path_with_namespace: 'octo/nuncio', default_branch: 'main' };
    const note = gitlab.parseWebhookEvent(
      { 'x-gitlab-event': 'Note Hook', 'x-gitlab-event-uuid': 'note-1' },
      {
        user: { username: 'reviewer' },
        object_attributes: {
          note: 'Please update this.', noteable_type: 'MergeRequest',
          url: 'https://gitlab.com/octo/nuncio/-/merge_requests/42#note_1',
          position: { new_path: 'src/gitlab.ts', new_line: 8 },
        },
        merge_request: { iid: 42, url: 'https://gitlab.com/octo/nuncio/-/merge_requests/42' },
        project,
      },
    );
    const pipeline = gitlab.parseWebhookEvent(
      { 'x-gitlab-event': 'Pipeline Hook', 'x-gitlab-event-uuid': 'pipeline-1' },
      {
        object_attributes: { id: 77, status: 'failed', name: 'pipeline' },
        merge_request: { iid: 42, url: 'https://gitlab.com/octo/nuncio/-/merge_requests/42' },
        project,
      },
    );

    expect(note).toMatchObject({
      kind: 'pull_request_feedback', number: 42, author: 'reviewer',
      comments: [{ body: 'Please update this.', path: 'src/gitlab.ts', line: 8 }],
    });
    expect(pipeline).toMatchObject({ kind: 'ci_failure', number: 42, runId: 77 });
  });

  it('marks closed and merged pull requests without changing opened-event compatibility', () => {
    const closed = github.parseWebhookEvent(
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'closed-1' },
      {
        action: 'closed',
        pull_request: {
          number: 42,
          title: 'Fix',
          body: 'Body',
          labels: [],
          merged: true,
          html_url: 'https://github.com/octo/nuncio/pull/42',
        },
        repository: githubRepo,
      },
    );

    expect(closed).toMatchObject({ kind: 'pull_request', action: 'closed', merged: true, number: 42 });
    expect(
      github.parseWebhookEvent(
        { 'x-github-event': 'pull_request', 'x-github-delivery': 'opened-1' },
        {
          action: 'opened',
          pull_request: { number: 42, title: 'Fix', body: 'Body', labels: [{ name: 'bug' }] },
          repository: githubRepo,
        },
      ),
    ).toEqual({
      provider: 'github', deliveryId: 'opened-1', kind: 'pull_request', action: 'opened',
      owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main',
      number: 42, title: 'Fix', body: 'Body', labels: ['bug'],
    });

    expect(
      gitlab.parseWebhookEvent(
        { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'merged-1' },
        {
          object_attributes: {
            iid: 42, title: 'Fix', description: 'Body', action: 'merge',
            url: 'https://gitlab.com/octo/nuncio/-/merge_requests/42',
          },
          project: { path_with_namespace: 'octo/nuncio', default_branch: 'main' },
        },
      ),
    ).toMatchObject({ kind: 'pull_request', action: 'closed', number: 42, merged: true });
  });

  it('ignores unsupported feedback and non-failing or unassociated CI payloads', () => {
    expect(
      github.parseWebhookEvent(
        { 'x-github-event': 'pull_request_review', 'x-github-delivery': 'dismissed' },
        {
          action: 'dismissed', review: { state: 'dismissed', user: { login: 'reviewer' } },
          pull_request: { number: 42 }, repository: githubRepo,
        },
      ),
    ).toBeNull();
    expect(
      github.parseWebhookEvent(
        { 'x-github-event': 'workflow_run', 'x-github-delivery': 'success' },
        {
          action: 'completed',
          workflow_run: { id: 1, conclusion: 'success', pull_requests: [{ number: 42 }] },
          repository: githubRepo,
        },
      ),
    ).toBeNull();
    expect(
      github.parseWebhookEvent(
        { 'x-github-event': 'check_run', 'x-github-delivery': 'no-pr' },
        { action: 'completed', check_run: { id: 1, conclusion: 'failure', pull_requests: [] }, repository: githubRepo },
      ),
    ).toBeNull();
    expect(
      gitlab.parseWebhookEvent(
        { 'x-gitlab-event': 'Pipeline Hook', 'x-gitlab-event-uuid': 'success' },
        {
          object_attributes: { id: 1, status: 'success' }, merge_request: { iid: 42 },
          project: { path_with_namespace: 'octo/nuncio', default_branch: 'main' },
        },
      ),
    ).toBeNull();
  });

  it('distinguishes same-repository and fork pull-request heads', () => {
    const githubBase = {
      number: 42, title: 'PR', state: 'open', html_url: 'https://github.com/octo/nuncio/pull/42',
      head: { ref: 'feat/pr', repo: { full_name: 'octo/nuncio' } },
      base: { ref: 'main', repo: { full_name: 'octo/nuncio' } },
    };
    expect(mapGithubPullDetail(githubBase, null).sourceRepositoryMatchesTarget).toBe(true);
    expect(mapGithubPullDetail({
      ...githubBase,
      head: { ref: 'main', repo: { full_name: 'contributor/nuncio' } },
    }, null).sourceRepositoryMatchesTarget).toBe(false);

    const gitlabBase = {
      iid: 42, title: 'MR', state: 'opened', web_url: 'https://gitlab.com/octo/nuncio/-/merge_requests/42',
      source_branch: 'feat/pr', target_branch: 'main', source_project_id: 1, target_project_id: 1,
    };
    expect(mapGitlabPullDetail(gitlabBase, false).sourceRepositoryMatchesTarget).toBe(true);
    expect(mapGitlabPullDetail({ ...gitlabBase, source_project_id: 2 }, false)
      .sourceRepositoryMatchesTarget).toBe(false);
  });
});
