import { routeWebhookCiFailure } from '../../../src/forges/webhooks/webhook-ci-failure-router';

describe('routeWebhookCiFailure', () => {
  it('bounds forge enrichment and durably hands off a log-less steer', async () => {
    const prompts: string[] = [];
    let accepted = false;
    const routing = routeWebhookCiFailure(
      {
        sessions: {
          steerInBackground: (_id: string, prompt: string) => prompts.push(prompt),
        },
        sessionRecords: {
          findByProjectPullRequest: () => ({ id: 'session-1' }),
        },
        forgeRepos: {
          getWorkflowRunJobs: () => new Promise(() => undefined),
          getJobLog: () => Promise.reject(new Error('must not fetch a job without an id')),
        },
        attention: { raise: () => undefined },
        accept: (work: () => unknown) => {
          accepted = true;
          return work();
        },
        enrichmentTimeoutMs: 5,
      } as never,
      'github',
      '/projects/nuncio',
      {
        provider: 'github', deliveryId: 'ci-timeout', kind: 'ci_failure', action: 'failed',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main',
        number: 7, runId: 90, jobName: 'CI', url: 'https://github.com/octo/nuncio/actions/runs/90',
        labels: [],
      },
    );

    const result = await Promise.race([
      routing,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    expect(result).toMatchObject({ steered: true, sessionId: 'session-1' });
    expect(accepted).toBe(true);
    expect(prompts[0]).toContain('Job: CI');
    expect(prompts[0]).toContain('[Job log unavailable]');
  });

  it('bounds a stalled job-log download within the same enrichment deadline', async () => {
    const prompts: string[] = [];
    let accepted = false;
    const routing = routeWebhookCiFailure(
      {
        sessions: {
          steerInBackground: (_id: string, prompt: string) => prompts.push(prompt),
        },
        sessionRecords: {
          findByProjectPullRequest: () => ({ id: 'session-1' }),
        },
        forgeRepos: {
          getWorkflowRunJobs: async () => [
            { id: 901, name: 'unit-tests', status: 'completed', conclusion: 'failure' },
          ],
          getJobLog: () => new Promise(() => undefined),
        },
        attention: { raise: () => undefined },
        accept: (work: () => unknown) => {
          accepted = true;
          return work();
        },
        enrichmentTimeoutMs: 5,
      } as never,
      'github',
      '/projects/nuncio',
      {
        provider: 'github', deliveryId: 'ci-log-timeout', kind: 'ci_failure', action: 'failed',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main',
        number: 7, runId: 90, jobName: 'CI', url: 'https://github.com/octo/nuncio/actions/runs/90',
        labels: [],
      },
    );

    const result = await Promise.race([
      routing,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    expect(result).toMatchObject({ steered: true, sessionId: 'session-1' });
    expect(accepted).toBe(true);
    expect(prompts[0]).toContain('Job: unit-tests');
    expect(prompts[0]).toContain('[Job log unavailable]');
  });
});
