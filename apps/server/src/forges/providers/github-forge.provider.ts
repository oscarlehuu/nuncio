import { Injectable } from '@nestjs/common';
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
import { GithubForgeActions } from './github-forge.actions';
import {
  mapGithubComment,
  mapGithubFileDiff,
  mapGithubIssueSummary,
  mapGithubPullDetail,
  mapGithubPullSummary,
  mapGithubReviewDecision,
  mapGithubThread,
  type GithubCommentResponse,
  type GithubFileResponse,
  type GithubIssueResponse,
  type GithubPullDetailResponse,
  type GithubPullSummaryResponse,
  type GithubThreadNode,
} from './github-forge.mappers';

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewDecision
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line
          comments(first: 100) {
            nodes { databaseId author { login } body createdAt }
          }
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

const UNRESOLVE_MUTATION = `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

interface ThreadsQueryData {
  repository?: {
    pullRequest?: {
      reviewDecision?: string | null;
      reviewThreads?: { nodes?: GithubThreadNode[] };
    };
  };
}

interface GithubMergeResponse {
  merged?: boolean;
  sha?: string | null;
  message?: string;
}

@Injectable()
export class GithubForgeProvider extends GithubForgeActions {
  constructor(settings: SettingsService) {
    super(settings);
  }

  capabilities(): ForgeCapabilities {
    return {
      requestChanges: true,
      rebaseMerge: true,
      mergeWhenChecksPass: false,
      resolveThreads: true,
      updateBranch: true,
      rerunFailedOnly: true,
    };
  }

  async listPullRequests(
    repo: ForgeRepoRef,
    state: ForgeStateFilter,
  ): Promise<ForgePullRequestSummary[]> {
    const data = await this.request<GithubPullSummaryResponse[]>(
      `${this.repoUrl(repo)}/pulls?state=${state}&sort=updated&direction=desc&per_page=50`,
      { headers: await this.authHeaders() },
    );
    return (data ?? []).map(mapGithubPullSummary);
  }

  async getPullRequestDetail(repo: ForgeRepoRef, number: number): Promise<ForgePullRequestDetail> {
    const [data, threads] = await Promise.all([
      this.request<GithubPullDetailResponse>(`${this.repoUrl(repo)}/pulls/${number}`, {
        headers: await this.authHeaders(),
      }),
      this.threadsQuery(repo, number).catch(() => null),
    ]);
    const decision = threads?.repository?.pullRequest?.reviewDecision ?? null;
    return mapGithubPullDetail(data, mapGithubReviewDecision(decision));
  }

  async listPullRequestFiles(repo: ForgeRepoRef, number: number): Promise<ForgeFileDiff[]> {
    const data = await this.request<GithubFileResponse[]>(
      `${this.repoUrl(repo)}/pulls/${number}/files?per_page=100`,
      { headers: await this.authHeaders() },
    );
    return (data ?? []).map(mapGithubFileDiff);
  }

  async listReviewThreads(repo: ForgeRepoRef, number: number): Promise<ForgeReviewThread[]> {
    const data = await this.threadsQuery(repo, number);
    const nodes = data.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.map(mapGithubThread);
  }

  async replyToThread(
    repo: ForgeRepoRef,
    number: number,
    replyTargetId: string,
    body: string,
  ): Promise<void> {
    await this.request<unknown>(
      `${this.repoUrl(repo)}/pulls/${number}/comments/${encodeURIComponent(replyTargetId)}/replies`,
      { method: 'POST', headers: await this.authHeaders(), body: JSON.stringify({ body }) },
    );
  }

  async resolveThread(
    _repo: ForgeRepoRef,
    _number: number,
    threadId: string,
    resolved: boolean,
  ): Promise<void> {
    await this.graphql<unknown>(resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { threadId });
  }

  async submitReview(repo: ForgeRepoRef, number: number, opts: SubmitReviewOptions): Promise<void> {
    const event =
      opts.event === 'approve'
        ? 'APPROVE'
        : opts.event === 'request_changes'
          ? 'REQUEST_CHANGES'
          : 'COMMENT';
    await this.request<unknown>(`${this.repoUrl(repo)}/pulls/${number}/reviews`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ event, body: opts.body ?? '' }),
    });
  }

  async mergePullRequest(
    repo: ForgeRepoRef,
    number: number,
    opts: MergePullRequestOptions,
  ): Promise<MergeResult> {
    const data = await this.request<GithubMergeResponse>(`${this.repoUrl(repo)}/pulls/${number}/merge`, {
      method: 'PUT',
      headers: await this.authHeaders(),
      body: JSON.stringify({
        merge_method: opts.method,
        commit_title: opts.commitTitle,
        commit_message: opts.commitMessage,
      }),
    });
    if (data.merged && opts.deleteSourceBranch) {
      await this.deleteSourceBranch(repo, number);
    }
    return { merged: data.merged ?? false, sha: data.sha ?? null, message: data.message ?? '' };
  }

  private async deleteSourceBranch(repo: ForgeRepoRef, number: number): Promise<void> {
    const detail = await this.request<GithubPullDetailResponse>(
      `${this.repoUrl(repo)}/pulls/${number}`,
      { headers: await this.authHeaders() },
    );
    const branch = detail.head?.ref;
    if (!branch) return;
    await this.request<unknown>(`${this.repoUrl(repo)}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    }).catch(() => {
      // Branch already gone (auto-delete on merge) — not an error worth surfacing.
    });
  }

  async updatePullRequestState(
    repo: ForgeRepoRef,
    number: number,
    state: 'open' | 'closed',
  ): Promise<void> {
    await this.request<unknown>(`${this.repoUrl(repo)}/pulls/${number}`, {
      method: 'PATCH',
      headers: await this.authHeaders(),
      body: JSON.stringify({ state }),
    });
  }

  async updateBranch(repo: ForgeRepoRef, number: number): Promise<void> {
    await this.request<unknown>(`${this.repoUrl(repo)}/pulls/${number}/update-branch`, {
      method: 'PUT',
      headers: await this.authHeaders(),
      body: JSON.stringify({}),
    });
  }

  async listIssues(repo: ForgeRepoRef, state: ForgeStateFilter): Promise<ForgeIssueSummary[]> {
    const data = await this.request<GithubIssueResponse[]>(
      `${this.repoUrl(repo)}/issues?state=${state}&sort=updated&direction=desc&per_page=50`,
      { headers: await this.authHeaders() },
    );
    // GitHub's issues endpoint also returns PRs; keep plain issues only.
    return (data ?? []).filter((item) => !item.pull_request).map(mapGithubIssueSummary);
  }

  async getIssue(repo: ForgeRepoRef, number: number): Promise<ForgeIssueDetail> {
    const [issue, comments] = await Promise.all([
      this.request<GithubIssueResponse>(`${this.repoUrl(repo)}/issues/${number}`, {
        headers: await this.authHeaders(),
      }),
      this.request<GithubCommentResponse[]>(
        `${this.repoUrl(repo)}/issues/${number}/comments?per_page=100`,
        { headers: await this.authHeaders() },
      ),
    ]);
    return {
      ...mapGithubIssueSummary(issue),
      body: issue.body ?? '',
      comments: (comments ?? []).map(mapGithubComment),
    };
  }

  async addIssueComment(repo: ForgeRepoRef, number: number, body: string): Promise<void> {
    await this.addComment(repo, number, body);
  }

  async updateIssueState(repo: ForgeRepoRef, number: number, state: 'open' | 'closed'): Promise<void> {
    await this.request<unknown>(`${this.repoUrl(repo)}/issues/${number}`, {
      method: 'PATCH',
      headers: await this.authHeaders(),
      body: JSON.stringify({ state }),
    });
  }

  async createIssue(repo: ForgeRepoRef, opts: CreateIssueOptions): Promise<ForgeIssueSummary> {
    const data = await this.request<GithubIssueResponse>(`${this.repoUrl(repo)}/issues`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ title: opts.title, body: opts.body, labels: opts.labels }),
    });
    return mapGithubIssueSummary(data);
  }

  private threadsQuery(repo: ForgeRepoRef, number: number): Promise<ThreadsQueryData> {
    return this.graphql<ThreadsQueryData>(THREADS_QUERY, {
      owner: repo.owner,
      repo: repo.repo,
      number,
    });
  }
}
