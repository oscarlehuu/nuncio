import { BadRequestException, Injectable } from '@nestjs/common';
import { GitService } from '../git/git.service';
import { ForgeRegistry, providerIdForHost } from './forges.registry';
import type {
  CreateIssueOptions,
  ForgeAuthMethod,
  ForgeCapabilities,
  ForgeCheck,
  ForgeComment,
  ForgeFileDiff,
  ForgeIssueDetail,
  ForgeIssueSummary,
  ForgeProvider,
  ForgePullRequestDetail,
  ForgePullRequestSummary,
  ForgeRepoRef,
  ForgeReviewThread,
  ForgeJobLog,
  ForgeStateFilter,
  ForgeWorkflowJob,
  ForgeWorkflowRun,
  MergePullRequestOptions,
  MergeResult,
  SubmitReviewOptions,
} from './forges.types';

export type ForgeRepoCapabilitiesDto = ForgeCapabilities & {
  provider: string;
  connected: boolean;
  authMethod: ForgeAuthMethod | null;
};

export type ForgePullRequestDetailDto = ForgePullRequestDetail & { checks: ForgeCheck[] };

interface ResolvedRepo {
  provider: ForgeProvider;
  repo: ForgeRepoRef;
  host: string;
}

/**
 * Repo-scoped facade: maps a local project path (via its origin remote) onto a
 * forge provider, so the web client can browse/act on PRs and issues for any
 * project — identified by `?path=`, the same convention as /api/projects/branches.
 */
@Injectable()
export class ForgeRepoService {
  constructor(
    private readonly registry: ForgeRegistry,
    private readonly git: GitService,
  ) {}

  async capabilities(path: string): Promise<ForgeRepoCapabilitiesDto> {
    const remote = await this.git.remoteInfo(this.requirePath(path));
    const provider = this.registry.get(providerIdForHost(remote.host));
    const auth = await provider.resolveAuth().catch(() => null);
    return {
      provider: provider.id,
      connected: auth !== null,
      authMethod: auth?.method ?? null,
      ...provider.capabilities(),
    };
  }

  async listPullRequests(path: string, state: ForgeStateFilter): Promise<ForgePullRequestSummary[]> {
    const { provider, repo } = await this.resolve(path);
    return provider.listPullRequests(repo, state);
  }

  async resolveRepoIdentity(path: string): Promise<string> {
    const { host, repo } = await this.resolve(path);
    return `${host}/${repo.owner}/${repo.repo}`.toLowerCase();
  }

  async getPullRequestDetail(path: string, number: number): Promise<ForgePullRequestDetailDto> {
    const { provider, repo } = await this.resolve(path);
    const detail = await provider.getPullRequestDetail(repo, number);
    const checks = detail.sourceBranch
      ? await provider.listChecks(repo, detail.sourceBranch).catch(() => [])
      : [];
    return { ...detail, checks };
  }

  async listPullRequestFiles(path: string, number: number): Promise<ForgeFileDiff[]> {
    const { provider, repo } = await this.resolve(path);
    return provider.listPullRequestFiles(repo, number);
  }

  async listReviewThreads(path: string, number: number): Promise<ForgeReviewThread[]> {
    const { provider, repo } = await this.resolve(path);
    return provider.listReviewThreads(repo, number);
  }

  async listPullRequestComments(path: string, number: number): Promise<ForgeComment[]> {
    const { provider, repo } = await this.resolve(path);
    return provider.listPullRequestComments(repo, number);
  }

  async replyToThread(path: string, number: number, replyTargetId: string, body: string): Promise<void> {
    const { provider, repo } = await this.resolve(path);
    await provider.replyToThread(repo, number, replyTargetId, this.requireBody(body));
  }

  async resolveThread(path: string, number: number, threadId: string, resolved: boolean): Promise<void> {
    const { provider, repo } = await this.resolve(path);
    await provider.resolveThread(repo, number, threadId, resolved);
  }

  async submitReview(path: string, number: number, opts: SubmitReviewOptions): Promise<void> {
    const { provider, repo } = await this.resolve(path);
    await provider.submitReview(repo, number, opts);
  }

  async addPullRequestComment(path: string, number: number, body: string): Promise<void> {
    const { provider, repo } = await this.resolve(path);
    await provider.addComment(repo, number, this.requireBody(body));
  }

  async mergePullRequest(path: string, number: number, opts: MergePullRequestOptions): Promise<MergeResult> {
    const { provider, repo } = await this.resolve(path);
    return provider.mergePullRequest(repo, number, opts);
  }

  async updatePullRequestState(path: string, number: number, state: 'open' | 'closed'): Promise<void> {
    const { provider, repo } = await this.resolve(path);
    await provider.updatePullRequestState(repo, number, state);
  }

  async updateBranch(path: string, number: number): Promise<void> {
    const { provider, repo } = await this.resolve(path);
    await provider.updateBranch(repo, number);
  }

  async listIssues(path: string, state: ForgeStateFilter): Promise<ForgeIssueSummary[]> {
    const { provider, repo } = await this.resolve(path);
    return provider.listIssues(repo, state);
  }

  async getIssue(path: string, number: number): Promise<ForgeIssueDetail> {
    const { provider, repo } = await this.resolve(path);
    return provider.getIssue(repo, number);
  }

  async addIssueComment(path: string, number: number, body: string): Promise<void> {
    const { provider, repo } = await this.resolve(path);
    await provider.addIssueComment(repo, number, this.requireBody(body));
  }

  async updateIssueState(path: string, number: number, state: 'open' | 'closed'): Promise<void> {
    const { provider, repo } = await this.resolve(path);
    await provider.updateIssueState(repo, number, state);
  }

  async createIssue(path: string, opts: CreateIssueOptions): Promise<ForgeIssueSummary> {
    const { provider, repo } = await this.resolve(path);
    if (!opts.title?.trim()) throw new BadRequestException('Issue title is required');
    return provider.createIssue(repo, { ...opts, body: opts.body ?? '' });
  }

  async listWorkflowRuns(path: string, branch?: string): Promise<ForgeWorkflowRun[]> {
    const { provider, repo } = await this.resolve(path);
    return provider.listWorkflowRuns(repo, { branch });
  }

  async getWorkflowRunJobs(path: string, runId: number): Promise<ForgeWorkflowJob[]> {
    const { provider, repo } = await this.resolve(path);
    return provider.getWorkflowRunJobs(repo, runId);
  }

  async rerunWorkflowRun(path: string, runId: number, failedOnly?: boolean): Promise<void> {
    const { provider, repo } = await this.resolve(path);
    await provider.rerunWorkflowRun(repo, runId, { failedOnly });
  }

  async cancelWorkflowRun(path: string, runId: number): Promise<void> {
    const { provider, repo } = await this.resolve(path);
    await provider.cancelWorkflowRun(repo, runId);
  }

  async getJobLog(path: string, jobId: number): Promise<ForgeJobLog> {
    const { provider, repo } = await this.resolve(path);
    return provider.getJobLog(repo, jobId);
  }

  private async resolve(path: string): Promise<ResolvedRepo> {
    const remote = await this.git.remoteInfo(this.requirePath(path));
    const provider = await this.registry.getAvailable(providerIdForHost(remote.host));
    return { provider, repo: { owner: remote.owner, repo: remote.repo }, host: remote.host };
  }

  private requirePath(path: string): string {
    const trimmed = path?.trim();
    if (!trimmed) throw new BadRequestException('path query parameter is required');
    return trimmed;
  }

  private requireBody(body: string): string {
    const trimmed = body?.trim();
    if (!trimmed) throw new BadRequestException('body is required');
    return trimmed;
  }
}
