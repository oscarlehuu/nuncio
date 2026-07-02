import type { ForgeJobLog, ForgeRepoRef, ForgeWorkflowJob, ForgeWorkflowRun } from '../forges.types';
import { GithubForgeCore } from './github-forge.core';
import {
  mapGithubWorkflowJob,
  mapGithubWorkflowRun,
  type GithubWorkflowJobResponse,
  type GithubWorkflowRunResponse,
} from './github-forge.mappers';

interface GithubRunsResponse {
  workflow_runs?: GithubWorkflowRunResponse[];
}

interface GithubJobsResponse {
  jobs?: GithubWorkflowJobResponse[];
}

/**
 * GitHub Actions surface (workflow runs / jobs / logs / rerun / cancel).
 * The review/merge/issue surface lives in GithubForgeProvider.
 */
export abstract class GithubForgeActions extends GithubForgeCore {
  async listWorkflowRuns(
    repo: ForgeRepoRef,
    opts: { branch?: string } = {},
  ): Promise<ForgeWorkflowRun[]> {
    const branchQuery = opts.branch ? `&branch=${encodeURIComponent(opts.branch)}` : '';
    const data = await this.request<GithubRunsResponse>(
      `${this.repoUrl(repo)}/actions/runs?per_page=30${branchQuery}`,
      { headers: await this.authHeaders() },
    );
    return (data.workflow_runs ?? []).map(mapGithubWorkflowRun);
  }

  async getWorkflowRunJobs(repo: ForgeRepoRef, runId: number): Promise<ForgeWorkflowJob[]> {
    const data = await this.request<GithubJobsResponse>(
      `${this.repoUrl(repo)}/actions/runs/${runId}/jobs?per_page=100`,
      { headers: await this.authHeaders() },
    );
    return (data.jobs ?? []).map(mapGithubWorkflowJob);
  }

  async rerunWorkflowRun(
    repo: ForgeRepoRef,
    runId: number,
    opts: { failedOnly?: boolean } = {},
  ): Promise<void> {
    const action = opts.failedOnly ? 'rerun-failed-jobs' : 'rerun';
    await this.request<unknown>(`${this.repoUrl(repo)}/actions/runs/${runId}/${action}`, {
      method: 'POST',
      headers: await this.authHeaders(),
    });
  }

  async cancelWorkflowRun(repo: ForgeRepoRef, runId: number): Promise<void> {
    await this.request<unknown>(`${this.repoUrl(repo)}/actions/runs/${runId}/cancel`, {
      method: 'POST',
      headers: await this.authHeaders(),
    });
  }

  async getJobLog(repo: ForgeRepoRef, jobId: number): Promise<ForgeJobLog> {
    const raw = await this.requestText(`${this.repoUrl(repo)}/actions/jobs/${jobId}/logs`, {
      headers: await this.authHeaders(),
    });
    return this.tailLog(raw);
  }
}
