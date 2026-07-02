import type { ForgeJobLog, ForgeRepoRef, ForgeWorkflowJob, ForgeWorkflowRun } from '../forges.types';
import { GitlabForgeCore } from './gitlab-forge.core';
import {
  mapGitlabPipeline,
  mapGitlabPipelineJob,
  type GitlabPipelineJobResponse,
  type GitlabPipelineListResponse,
} from './gitlab-forge.mappers';

/**
 * GitLab CI surface (pipelines / jobs / traces / retry / cancel).
 * The review/merge/issue surface lives in GitlabForgeProvider.
 */
export abstract class GitlabForgeActions extends GitlabForgeCore {
  async listWorkflowRuns(
    repo: ForgeRepoRef,
    opts: { branch?: string } = {},
  ): Promise<ForgeWorkflowRun[]> {
    const refQuery = opts.branch ? `&ref=${encodeURIComponent(opts.branch)}` : '';
    const data = await this.request<GitlabPipelineListResponse[]>(
      `${this.projectUrl(repo)}/pipelines?per_page=30${refQuery}`,
      { headers: await this.authHeaders() },
    );
    return (data ?? []).map(mapGitlabPipeline);
  }

  async getWorkflowRunJobs(repo: ForgeRepoRef, runId: number): Promise<ForgeWorkflowJob[]> {
    const data = await this.request<GitlabPipelineJobResponse[]>(
      `${this.projectUrl(repo)}/pipelines/${runId}/jobs?per_page=100`,
      { headers: await this.authHeaders() },
    );
    return (data ?? []).map(mapGitlabPipelineJob);
  }

  /** GitLab's retry re-runs failed/canceled jobs — the failedOnly flag is implicit. */
  async rerunWorkflowRun(repo: ForgeRepoRef, runId: number): Promise<void> {
    await this.request<unknown>(`${this.projectUrl(repo)}/pipelines/${runId}/retry`, {
      method: 'POST',
      headers: await this.authHeaders(),
    });
  }

  async cancelWorkflowRun(repo: ForgeRepoRef, runId: number): Promise<void> {
    await this.request<unknown>(`${this.projectUrl(repo)}/pipelines/${runId}/cancel`, {
      method: 'POST',
      headers: await this.authHeaders(),
    });
  }

  async getJobLog(repo: ForgeRepoRef, jobId: number): Promise<ForgeJobLog> {
    const raw = await this.requestText(`${this.projectUrl(repo)}/jobs/${jobId}/trace`, {
      headers: await this.authHeaders(),
    });
    return this.tailLog(raw);
  }
}
