import { BadRequestException, Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.service';
import type {
  CreateIssueOptions,
  ForgeCapabilities,
  ForgeFileDiff,
  ForgeIssueDetail,
  ForgeIssueSummary,
  ForgePullRequestDetail,
  ForgePullRequestSummary,
  ForgeRepoRef,
  ForgeReviewThread,
  ForgeStateFilter,
  MergePullRequestOptions,
  MergeResult,
  SubmitReviewOptions,
} from '../forges.types';
import { GitlabForgeActions } from './gitlab-forge.actions';
import {
  mapGitlabDiscussion,
  mapGitlabFileDiff,
  mapGitlabIssueSummary,
  mapGitlabMrSummary,
  mapGitlabNote,
  mapGitlabPullDetail,
  type GitlabDiffResponse,
  type GitlabDiscussionResponse,
  type GitlabIssueResponse,
  type GitlabMrDetailResponse,
  type GitlabMrSummaryResponse,
  type GitlabNoteResponse,
} from './gitlab-forge.mappers';

interface GitlabApprovalsResponse {
  approved?: boolean;
}

interface GitlabMergeResponse {
  state?: string;
  merge_commit_sha?: string | null;
  sha?: string | null;
}

@Injectable()
export class GitlabForgeProvider extends GitlabForgeActions {
  constructor(settings: SettingsService) {
    super(settings);
  }

  capabilities(): ForgeCapabilities {
    return {
      requestChanges: false,
      rebaseMerge: false,
      mergeWhenChecksPass: true,
      resolveThreads: true,
      updateBranch: true,
      rerunFailedOnly: false,
    };
  }

  async listPullRequests(
    repo: ForgeRepoRef,
    state: ForgeStateFilter,
  ): Promise<ForgePullRequestSummary[]> {
    const stateParam = state === 'open' ? 'opened' : state;
    const data = await this.request<GitlabMrSummaryResponse[]>(
      `${this.projectUrl(repo)}/merge_requests?state=${stateParam}&order_by=updated_at&sort=desc&per_page=50`,
      { headers: await this.authHeaders() },
    );
    return (data ?? []).map(mapGitlabMrSummary);
  }

  async getPullRequestDetail(repo: ForgeRepoRef, number: number): Promise<ForgePullRequestDetail> {
    const [detail, approvals] = await Promise.all([
      this.request<GitlabMrDetailResponse>(`${this.projectUrl(repo)}/merge_requests/${number}`, {
        headers: await this.authHeaders(),
      }),
      this.request<GitlabApprovalsResponse>(
        `${this.projectUrl(repo)}/merge_requests/${number}/approvals`,
        { headers: await this.authHeaders() },
      ).catch(() => ({ approved: false })),
    ]);
    return mapGitlabPullDetail(detail, approvals.approved ?? false);
  }

  async listPullRequestFiles(repo: ForgeRepoRef, number: number): Promise<ForgeFileDiff[]> {
    const data = await this.request<GitlabDiffResponse[]>(
      `${this.projectUrl(repo)}/merge_requests/${number}/diffs?per_page=100`,
      { headers: await this.authHeaders() },
    );
    return (data ?? []).map(mapGitlabFileDiff);
  }

  async listReviewThreads(repo: ForgeRepoRef, number: number): Promise<ForgeReviewThread[]> {
    const data = await this.request<GitlabDiscussionResponse[]>(
      `${this.projectUrl(repo)}/merge_requests/${number}/discussions?per_page=100`,
      { headers: await this.authHeaders() },
    );
    return (data ?? [])
      .map(mapGitlabDiscussion)
      .filter((thread): thread is ForgeReviewThread => thread !== null);
  }

  async replyToThread(
    repo: ForgeRepoRef,
    number: number,
    replyTargetId: string,
    body: string,
  ): Promise<void> {
    await this.request<unknown>(
      `${this.projectUrl(repo)}/merge_requests/${number}/discussions/${encodeURIComponent(replyTargetId)}/notes`,
      { method: 'POST', headers: await this.authHeaders(), body: JSON.stringify({ body }) },
    );
  }

  async resolveThread(
    repo: ForgeRepoRef,
    number: number,
    threadId: string,
    resolved: boolean,
  ): Promise<void> {
    await this.request<unknown>(
      `${this.projectUrl(repo)}/merge_requests/${number}/discussions/${encodeURIComponent(threadId)}?resolved=${resolved}`,
      { method: 'PUT', headers: await this.authHeaders() },
    );
  }

  async submitReview(repo: ForgeRepoRef, number: number, opts: SubmitReviewOptions): Promise<void> {
    if (opts.event === 'request_changes') {
      throw new BadRequestException('GitLab does not support request-changes reviews');
    }
    if (opts.event === 'approve') {
      await this.request<unknown>(`${this.projectUrl(repo)}/merge_requests/${number}/approve`, {
        method: 'POST',
        headers: await this.authHeaders(),
      });
      if (opts.body?.trim()) await this.addComment(repo, number, opts.body);
      return;
    }
    if (!opts.body?.trim()) {
      throw new BadRequestException('A comment review needs a body');
    }
    await this.addComment(repo, number, opts.body);
  }

  async mergePullRequest(
    repo: ForgeRepoRef,
    number: number,
    opts: MergePullRequestOptions,
  ): Promise<MergeResult> {
    if (opts.method === 'rebase') {
      throw new BadRequestException('GitLab does not support rebase merges via the API');
    }
    const data = await this.request<GitlabMergeResponse>(
      `${this.projectUrl(repo)}/merge_requests/${number}/merge`,
      {
        method: 'PUT',
        headers: await this.authHeaders(),
        body: JSON.stringify({
          squash: opts.method === 'squash',
          should_remove_source_branch: opts.deleteSourceBranch ?? false,
          merge_when_pipeline_succeeds: opts.mergeWhenChecksPass ?? false,
          squash_commit_message: opts.commitMessage,
        }),
      },
    );
    return {
      merged: data.state === 'merged',
      sha: data.merge_commit_sha ?? data.sha ?? null,
      message: data.state === 'merged' ? '' : `merge accepted, state: ${data.state ?? 'unknown'}`,
    };
  }

  async updatePullRequestState(
    repo: ForgeRepoRef,
    number: number,
    state: 'open' | 'closed',
  ): Promise<void> {
    await this.request<unknown>(`${this.projectUrl(repo)}/merge_requests/${number}`, {
      method: 'PUT',
      headers: await this.authHeaders(),
      body: JSON.stringify({ state_event: state === 'closed' ? 'close' : 'reopen' }),
    });
  }

  async updateBranch(repo: ForgeRepoRef, number: number): Promise<void> {
    await this.request<unknown>(`${this.projectUrl(repo)}/merge_requests/${number}/rebase`, {
      method: 'PUT',
      headers: await this.authHeaders(),
    });
  }

  async listIssues(repo: ForgeRepoRef, state: ForgeStateFilter): Promise<ForgeIssueSummary[]> {
    const stateParam = state === 'open' ? 'opened' : state;
    const stateQuery = state === 'all' ? '' : `state=${stateParam}&`;
    const data = await this.request<GitlabIssueResponse[]>(
      `${this.projectUrl(repo)}/issues?${stateQuery}order_by=updated_at&sort=desc&per_page=50`,
      { headers: await this.authHeaders() },
    );
    return (data ?? []).map(mapGitlabIssueSummary);
  }

  async getIssue(repo: ForgeRepoRef, number: number): Promise<ForgeIssueDetail> {
    const [issue, notes] = await Promise.all([
      this.request<GitlabIssueResponse>(`${this.projectUrl(repo)}/issues/${number}`, {
        headers: await this.authHeaders(),
      }),
      this.request<GitlabNoteResponse[]>(
        `${this.projectUrl(repo)}/issues/${number}/notes?sort=asc&per_page=100`,
        { headers: await this.authHeaders() },
      ),
    ]);
    return {
      ...mapGitlabIssueSummary(issue),
      body: issue.description ?? '',
      comments: (notes ?? []).filter((note) => !note.system).map(mapGitlabNote),
    };
  }

  async addIssueComment(repo: ForgeRepoRef, number: number, body: string): Promise<void> {
    // Issue notes live on a different endpoint than MR notes (addComment).
    await this.request<unknown>(`${this.projectUrl(repo)}/issues/${number}/notes`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ body }),
    });
  }

  async updateIssueState(repo: ForgeRepoRef, number: number, state: 'open' | 'closed'): Promise<void> {
    await this.request<unknown>(`${this.projectUrl(repo)}/issues/${number}`, {
      method: 'PUT',
      headers: await this.authHeaders(),
      body: JSON.stringify({ state_event: state === 'closed' ? 'close' : 'reopen' }),
    });
  }

  async createIssue(repo: ForgeRepoRef, opts: CreateIssueOptions): Promise<ForgeIssueSummary> {
    const data = await this.request<GitlabIssueResponse>(`${this.projectUrl(repo)}/issues`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({
        title: opts.title,
        description: opts.body,
        labels: opts.labels?.join(','),
      }),
    });
    return mapGitlabIssueSummary(data);
  }
}
