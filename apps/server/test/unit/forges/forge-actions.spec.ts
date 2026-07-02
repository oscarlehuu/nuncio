import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GithubForgeProvider } from '../../../src/forges/providers/github-forge.provider';
import { GitlabForgeProvider } from '../../../src/forges/providers/gitlab-forge.provider';
import { SettingsModule } from '../../../src/settings/settings.module';

type FetchCall = { url: string; init?: RequestInit };

function makeRoutedFetch(
  routes: Array<{ match: (url: string, method: string) => boolean; body?: unknown; text?: string }>,
) {
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
      text: async () => route?.text ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchOverride, calls };
}

const repo = { owner: 'octo', repo: 'repo' };

describe('GithubForgeProvider — Actions surface', () => {
  let module: TestingModule;
  let provider: GithubForgeProvider;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-github-actions-'));
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

  it('listWorkflowRuns maps runs and computes duration for completed ones', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      {
        match: (url) => url.includes('/actions/runs?'),
        body: {
          workflow_runs: [
            {
              id: 900,
              name: 'CI',
              run_number: 17,
              status: 'completed',
              conclusion: 'failure',
              head_branch: 'main',
              head_sha: 'abc',
              event: 'push',
              actor: { login: 'oscar' },
              html_url: 'https://github.com/octo/repo/actions/runs/900',
              created_at: '2026-07-02T08:00:00Z',
              run_started_at: '2026-07-02T08:00:00Z',
              updated_at: '2026-07-02T08:02:30Z',
            },
            {
              id: 901,
              name: 'CI',
              status: 'in_progress',
              conclusion: null,
              html_url: 'u',
            },
          ],
        },
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const runs = await provider.listWorkflowRuns(repo, { branch: 'main' });

    expect(calls[0].url).toBe(
      'https://api.github.com/repos/octo/repo/actions/runs?per_page=30&branch=main',
    );
    expect(runs[0]).toMatchObject({
      id: 900,
      name: 'CI',
      runNumber: 17,
      status: 'completed',
      conclusion: 'failure',
      branch: 'main',
      actor: 'oscar',
      durationSeconds: 150,
    });
    expect(runs[1]).toMatchObject({ status: 'running', durationSeconds: null });
  });

  it('getWorkflowRunJobs maps jobs with steps', async () => {
    const { fetchOverride } = makeRoutedFetch([
      {
        match: (url) => url.includes('/actions/runs/900/jobs'),
        body: {
          jobs: [
            {
              id: 5001,
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              started_at: 's',
              completed_at: 'c',
              steps: [
                { name: 'checkout', status: 'completed', conclusion: 'success' },
                { name: 'test', status: 'completed', conclusion: 'failure' },
              ],
            },
          ],
        },
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const jobs = await provider.getWorkflowRunJobs(repo, 900);
    expect(jobs[0].steps).toHaveLength(2);
    expect(jobs[0].steps[1]).toEqual({ name: 'test', status: 'completed', conclusion: 'failure' });
  });

  it('rerun uses rerun-failed-jobs when failedOnly and cancel POSTs cancel', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([{ match: () => true, body: {} }]);
    provider.fetchOverride = fetchOverride;

    await provider.rerunWorkflowRun(repo, 900, { failedOnly: true });
    await provider.rerunWorkflowRun(repo, 900);
    await provider.cancelWorkflowRun(repo, 900);

    expect(calls[0].url).toContain('/actions/runs/900/rerun-failed-jobs');
    expect(calls[1].url).toContain('/actions/runs/900/rerun');
    expect(calls[2].url).toContain('/actions/runs/900/cancel');
    expect(calls.every((c) => c.init?.method === 'POST')).toBe(true);
  });

  it('getJobLog strips ANSI codes and tails long logs on a line boundary', async () => {
    const longLog = `${'x'.repeat(70_000)}\nline-a\n[31mline-b-red[0m\n`;
    const { fetchOverride, calls } = makeRoutedFetch([
      { match: (url) => url.includes('/actions/jobs/5001/logs'), text: longLog },
    ]);
    provider.fetchOverride = fetchOverride;

    const result = await provider.getJobLog(repo, 5001);

    expect(calls[0].url).toContain('/actions/jobs/5001/logs');
    expect(result.truncated).toBe(true);
    expect(result.log.endsWith('line-a\nline-b-red\n')).toBe(true);
    expect(result.log).not.toContain('');
  });
});

describe('GitlabForgeProvider — Actions surface', () => {
  let module: TestingModule;
  let provider: GitlabForgeProvider;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-gitlab-actions-'));
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

  it('listWorkflowRuns maps pipelines with normalized status', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      {
        match: (url) => url.includes('/pipelines?'),
        body: [
          {
            id: 77,
            status: 'failed',
            ref: 'main',
            sha: 'abc',
            source: 'push',
            web_url: 'https://gitlab.com/octo/repo/-/pipelines/77',
            created_at: '2026-07-02T08:00:00Z',
          },
          { id: 78, status: 'running', web_url: 'u' },
        ],
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const runs = await provider.listWorkflowRuns(repo, { branch: 'main' });

    expect(calls[0].url).toBe(
      'https://gitlab.com/api/v4/projects/octo%2Frepo/pipelines?per_page=30&ref=main',
    );
    expect(runs[0]).toMatchObject({
      id: 77,
      name: 'Pipeline #77',
      status: 'completed',
      conclusion: 'failure',
      branch: 'main',
    });
    expect(runs[1]).toMatchObject({ status: 'running', conclusion: null });
  });

  it('jobs carry their stage prefix and have no steps', async () => {
    const { fetchOverride } = makeRoutedFetch([
      {
        match: (url) => url.includes('/pipelines/77/jobs'),
        body: [{ id: 8001, name: 'unit', stage: 'test', status: 'success' }],
      },
    ]);
    provider.fetchOverride = fetchOverride;

    const jobs = await provider.getWorkflowRunJobs(repo, 77);
    expect(jobs[0]).toMatchObject({
      name: 'test: unit',
      status: 'completed',
      conclusion: 'success',
      steps: [],
    });
  });

  it('retry / cancel / trace hit the pipeline and job endpoints', async () => {
    const { fetchOverride, calls } = makeRoutedFetch([
      { match: (url) => url.includes('/trace'), text: 'job output' },
      { match: () => true, body: {} },
    ]);
    provider.fetchOverride = fetchOverride;

    await provider.rerunWorkflowRun(repo, 77);
    await provider.cancelWorkflowRun(repo, 77);
    const log = await provider.getJobLog(repo, 8001);

    expect(calls[0].url).toContain('/pipelines/77/retry');
    expect(calls[1].url).toContain('/pipelines/77/cancel');
    expect(calls[2].url).toContain('/jobs/8001/trace');
    expect(log).toEqual({ log: 'job output', truncated: false });
  });
});
