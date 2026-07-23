import { HttpException } from '@nestjs/common';
import type {
  CreateIssueOptions,
  CreatePullRequestOptions,
  ForgeAuth,
  ForgeCapabilities,
  ForgeCheck,
  ForgeComment,
  ForgeFileDiff,
  ForgeIssueDetail,
  ForgeIssueSummary,
  ForgeProvider,
  ForgePullRequest,
  ForgePullRequestDetail,
  ForgePullRequestPage,
  ForgePullRequestSummary,
  ForgeRepoRef,
  ForgeRepository,
  ForgeReviewThread,
  ForgeJobLog,
  ForgeStateFilter,
  ForgeUser,
  ForgeWebhookEvent,
  ForgeWorkflowJob,
  ForgeWorkflowRun,
  MergePullRequestOptions,
  MergeResult,
  SubmitReviewOptions,
} from './forges.types';

export abstract class BaseForgeProvider implements ForgeProvider {
  abstract readonly id: string;
  abstract readonly name: string;

  /** Test hook: inject a stub fetch implementation instead of global fetch. */
  fetchOverride?: typeof fetch;
  /** Test hook: inject a CLI token resolver without shelling out to gh/glab. */
  cliTokenOverride?: () => Promise<string | null>;

  abstract isAvailable(): Promise<boolean>;
  abstract resolveAuth(): Promise<ForgeAuth | null>;
  abstract getCurrentUser(): Promise<ForgeUser>;
  abstract canWriteRepository(repo: ForgeRepoRef, username: string): Promise<boolean>;
  abstract listRepositories(): Promise<ForgeRepository[]>;
  abstract createPullRequest(
    repo: ForgeRepoRef,
    opts: CreatePullRequestOptions,
  ): Promise<ForgePullRequest>;
  abstract getPullRequest(repo: ForgeRepoRef, number: number): Promise<ForgePullRequest>;
  abstract listChecks(repo: ForgeRepoRef, ref: string): Promise<ForgeCheck[]>;
  abstract addComment(repo: ForgeRepoRef, number: number, body: string): Promise<void>;
  abstract capabilities(): ForgeCapabilities;
  abstract listPullRequests(
    repo: ForgeRepoRef,
    state: ForgeStateFilter,
  ): Promise<ForgePullRequestSummary[]>;
  abstract listPullRequestsPaged(
    repo: ForgeRepoRef,
    state: ForgeStateFilter,
  ): Promise<ForgePullRequestPage>;
  abstract getPullRequestDetail(repo: ForgeRepoRef, number: number): Promise<ForgePullRequestDetail>;
  abstract listPullRequestFiles(repo: ForgeRepoRef, number: number): Promise<ForgeFileDiff[]>;
  abstract listReviewThreads(repo: ForgeRepoRef, number: number): Promise<ForgeReviewThread[]>;
  abstract listPullRequestComments(repo: ForgeRepoRef, number: number): Promise<ForgeComment[]>;
  abstract replyToThread(
    repo: ForgeRepoRef,
    number: number,
    replyTargetId: string,
    body: string,
  ): Promise<void>;
  abstract resolveThread(
    repo: ForgeRepoRef,
    number: number,
    threadId: string,
    resolved: boolean,
  ): Promise<void>;
  abstract submitReview(
    repo: ForgeRepoRef,
    number: number,
    opts: SubmitReviewOptions,
  ): Promise<void>;
  abstract mergePullRequest(
    repo: ForgeRepoRef,
    number: number,
    opts: MergePullRequestOptions,
  ): Promise<MergeResult>;
  abstract updatePullRequestState(
    repo: ForgeRepoRef,
    number: number,
    state: 'open' | 'closed',
  ): Promise<void>;
  abstract updateBranch(repo: ForgeRepoRef, number: number): Promise<void>;
  abstract listIssues(repo: ForgeRepoRef, state: ForgeStateFilter): Promise<ForgeIssueSummary[]>;
  abstract getIssue(repo: ForgeRepoRef, number: number): Promise<ForgeIssueDetail>;
  abstract addIssueComment(repo: ForgeRepoRef, number: number, body: string): Promise<void>;
  abstract updateIssueState(
    repo: ForgeRepoRef,
    number: number,
    state: 'open' | 'closed',
  ): Promise<void>;
  abstract createIssue(repo: ForgeRepoRef, opts: CreateIssueOptions): Promise<ForgeIssueSummary>;
  abstract listWorkflowRuns(
    repo: ForgeRepoRef,
    opts?: { branch?: string },
  ): Promise<ForgeWorkflowRun[]>;
  abstract getWorkflowRunJobs(repo: ForgeRepoRef, runId: number): Promise<ForgeWorkflowJob[]>;
  abstract rerunWorkflowRun(
    repo: ForgeRepoRef,
    runId: number,
    opts?: { failedOnly?: boolean },
  ): Promise<void>;
  abstract cancelWorkflowRun(repo: ForgeRepoRef, runId: number): Promise<void>;
  abstract getJobLog(repo: ForgeRepoRef, jobId: number): Promise<ForgeJobLog>;
  abstract verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): boolean;
  abstract parseWebhookEvent(
    headers: Record<string, string | undefined>,
    payload: unknown,
  ): ForgeWebhookEvent | null;
  abstract bustCache(): void;

  protected async request<T>(url: string, init?: RequestInit): Promise<T> {
    const fetchImpl = this.fetchOverride ?? fetch;
    const response = await fetchImpl(url, init);
    const body = await this.parseJson(response);

    if (!response.ok) {
      const message = this.errorMessage(response, body);
      throw new HttpException(message, response.status);
    }

    return body as T;
  }

  /**
   * Follow forge pagination from page 1, accumulating every page's array items
   * until `hasNextPage` reports no more or `maxPages` is reached. Returns the
   * flat item list plus `capped` (true only when the cap stopped an ongoing
   * sequence), so a caller can keep a derived count honest. `hasNextPage` reads
   * the forge's own cursor (GitHub `Link` rel="next", GitLab `X-Next-Page`);
   * a non-array or headerless response is treated as a final, empty page.
   */
  protected async fetchAllPages<TItem>(opts: {
    buildUrl: (page: number) => string;
    init: RequestInit;
    hasNextPage: (response: Response) => boolean;
    maxPages: number;
  }): Promise<{ items: TItem[]; capped: boolean }> {
    const fetchImpl = this.fetchOverride ?? fetch;
    const items: TItem[] = [];
    let page = 1;
    for (;;) {
      const response = await fetchImpl(opts.buildUrl(page), opts.init);
      const body = await this.parseJson(response);
      if (!response.ok) {
        throw new HttpException(this.errorMessage(response, body), response.status);
      }
      if (Array.isArray(body)) items.push(...(body as TItem[]));
      if (!opts.hasNextPage(response)) return { items, capped: false };
      if (page >= opts.maxPages) return { items, capped: true };
      page += 1;
    }
  }

  /** Plain-text fetch (job logs / traces); follows the forge's redirect to log storage. */
  protected async requestText(url: string, init?: RequestInit): Promise<string> {
    const fetchImpl = this.fetchOverride ?? fetch;
    const response = await fetchImpl(url, init);
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new HttpException(
        `${this.name} request failed (${response.status}): ${response.statusText || 'log fetch failed'}`,
        response.status,
      );
    }
    return text;
  }

  /** Tail a raw CI log: strip ANSI escapes and keep the last `maxBytes`. */
  protected tailLog(raw: string, maxBytes = 64_000): { log: string; truncated: boolean } {
    const clean = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    if (clean.length <= maxBytes) return { log: clean, truncated: false };
    const tail = clean.slice(-maxBytes);
    // Drop the partial first line so the tail starts on a line boundary.
    const firstNewline = tail.indexOf('\n');
    return { log: firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail, truncated: true };
  }

  private async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private errorMessage(response: Response, body: unknown): string {
    const forgeMessage =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : response.statusText || 'request failed';
    return `${this.name} request failed (${response.status}): ${forgeMessage}`;
  }
}
