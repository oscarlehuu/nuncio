export type ForgeAuthMethod = 'token' | 'cli';

export interface ForgeAuth {
  token: string;
  method: ForgeAuthMethod;
}

export interface ForgeUser {
  login: string;
  name: string | null;
}

export interface ForgeStatusDto {
  id: string;
  name: string;
  connected: boolean;
  method: ForgeAuthMethod | null;
  login: string | null;
}

export interface ForgeRepoRef {
  owner: string;
  repo: string;
}

/** A repository the authenticated user can clone (forge-aware project picker). */
export interface ForgeRepository {
  /** Opaque forge id (string form) — stable per repo, used as a React key. */
  id: string;
  /** owner/name (GitHub) or namespace/path (GitLab). */
  fullName: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  /** HTTPS clone URL used by POST /projects/clone. */
  cloneUrl: string;
  webUrl: string;
  /** ISO-8601 last-activity timestamp, or null when the forge omits it. */
  updatedAt: string | null;
}

export interface CreatePullRequestOptions {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface ForgeCheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface ForgePullRequest {
  number: number;
  url: string;
  state: string;
  title: string;
  /** Populated by getPullRequestForSession (refresh); omitted on create. */
  checks?: ForgeCheck[];
}

/**
 * Per-provider feature flags: (forge feature) × (what the current auth can do).
 * The web client renders unavailable actions disabled with a reason — it never
 * prompts for re-auth and never branches on provider id.
 */
export interface ForgeCapabilities {
  requestChanges: boolean;
  rebaseMerge: boolean;
  mergeWhenChecksPass: boolean;
  resolveThreads: boolean;
  updateBranch: boolean;
  /** Re-run only the failed jobs of a run (GitHub); GitLab's retry already means that. */
  rerunFailedOnly: boolean;
  /** Provider can enumerate the user's repositories (forge-aware project picker). */
  listRepositories: boolean;
}

export interface ForgePullRequestSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  updatedAt: string;
  /** Null when the forge's list endpoint does not report a count (GitHub). */
  commentCount: number | null;
}

export type ForgeMergeableState = 'mergeable' | 'conflicts' | 'blocked' | 'behind' | 'unknown';
export type ForgeReviewDecision = 'approved' | 'changes_requested' | 'review_required';

export interface ForgePullRequestDetail extends ForgePullRequest {
  body: string;
  author: string;
  draft: boolean;
  sourceBranch: string;
  /** True only when the PR head is in the same repository as the target. */
  sourceRepositoryMatchesTarget?: boolean;
  targetBranch: string;
  mergeable: ForgeMergeableState;
  reviewDecision: ForgeReviewDecision | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface ForgeFileDiff {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  /** Unified diff hunks; null when binary or too large to inline. */
  patch: string | null;
}

export interface ForgeComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ForgeReviewThread {
  /** Opaque id used for resolve/unresolve. */
  id: string;
  /** Opaque id used to reply into the thread; null when replying is unsupported. */
  replyTargetId: string | null;
  resolved: boolean | null;
  resolvable: boolean;
  path: string | null;
  line: number | null;
  outdated: boolean;
  comments: ForgeComment[];
}

export interface ForgeIssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  assignees: string[];
  commentCount: number;
  updatedAt: string;
  url: string;
}

export interface ForgeIssueDetail extends ForgeIssueSummary {
  body: string;
  comments: ForgeComment[];
}

export type ForgeStateFilter = 'open' | 'closed' | 'all';
export type ForgeMergeMethod = 'merge' | 'squash' | 'rebase';

export interface MergePullRequestOptions {
  method: ForgeMergeMethod;
  deleteSourceBranch?: boolean;
  /** GitLab only (capability mergeWhenChecksPass): queue merge until pipeline passes. */
  mergeWhenChecksPass?: boolean;
  commitTitle?: string;
  commitMessage?: string;
}

export interface MergeResult {
  merged: boolean;
  sha: string | null;
  message: string;
}

export type ForgeReviewEvent = 'approve' | 'request_changes' | 'comment';

/** Normalized run lifecycle: queued → running → completed (+ conclusion). */
export type ForgeRunStatus = 'queued' | 'running' | 'completed';

export interface ForgeWorkflowRun {
  id: number;
  /** Workflow name (GitHub) or "Pipeline #<id>" (GitLab has no run names). */
  name: string;
  runNumber: number | null;
  status: ForgeRunStatus;
  conclusion: string | null;
  branch: string;
  sha: string;
  event: string;
  actor: string;
  url: string;
  createdAt: string;
  durationSeconds: number | null;
}

export interface ForgeWorkflowStep {
  name: string;
  status: ForgeRunStatus;
  conclusion: string | null;
}

export interface ForgeWorkflowJob {
  id: number;
  name: string;
  status: ForgeRunStatus;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Empty on GitLab — its REST API has no per-step breakdown. */
  steps: ForgeWorkflowStep[];
}

export interface ForgeJobLog {
  log: string;
  truncated: boolean;
}

export interface SubmitReviewOptions {
  event: ForgeReviewEvent;
  body?: string;
}

export interface CreateIssueOptions {
  title: string;
  body: string;
  labels?: string[];
}

interface ForgeWebhookEventBase {
  provider: string;
  deliveryId: string;
  owner: string;
  repo: string;
  repoFullName: string;
  defaultBranch: string;
  /** Retained on every event because scheduler webhook filters match labels generically. */
  labels: string[];
}

export interface ForgeIssueWebhookEvent extends ForgeWebhookEventBase {
  kind: 'issue';
  action: string;
  number: number;
  title: string;
  body: string;
}

export interface ForgePullRequestWebhookEvent extends ForgeWebhookEventBase {
  kind: 'pull_request';
  action: string;
  number: number;
  title: string;
  body: string;
  merged?: boolean;
  url?: string;
}

export type ForgeReviewState = 'approved' | 'changes_requested' | 'commented';

export interface ForgeFeedbackComment {
  body: string;
  path?: string;
  line?: number;
}

export interface ForgePullRequestFeedbackWebhookEvent extends ForgeWebhookEventBase {
  kind: 'pull_request_feedback';
  action: string;
  number: number;
  author: string;
  reviewState?: ForgeReviewState;
  comments: ForgeFeedbackComment[];
  url: string;
}

export interface ForgeCiFailureWebhookEvent extends ForgeWebhookEventBase {
  kind: 'ci_failure';
  action: 'failed';
  number: number;
  runId?: number;
  jobId?: number;
  jobName: string;
  url: string;
}

export type ForgeWebhookEvent =
  | ForgeIssueWebhookEvent
  | ForgePullRequestWebhookEvent
  | ForgePullRequestFeedbackWebhookEvent
  | ForgeCiFailureWebhookEvent;

export interface ForgeProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  resolveAuth(): Promise<ForgeAuth | null>;
  getCurrentUser(): Promise<ForgeUser>;
  capabilities(): ForgeCapabilities;
  /** Enumerate the authenticated user's repositories (forge-aware picker). */
  listRepositories(): Promise<ForgeRepository[]>;
  createPullRequest(repo: ForgeRepoRef, opts: CreatePullRequestOptions): Promise<ForgePullRequest>;
  getPullRequest(repo: ForgeRepoRef, number: number): Promise<ForgePullRequest>;
  listChecks(repo: ForgeRepoRef, ref: string): Promise<ForgeCheck[]>;
  addComment(repo: ForgeRepoRef, number: number, body: string): Promise<void>;
  listPullRequests(repo: ForgeRepoRef, state: ForgeStateFilter): Promise<ForgePullRequestSummary[]>;
  getPullRequestDetail(repo: ForgeRepoRef, number: number): Promise<ForgePullRequestDetail>;
  listPullRequestFiles(repo: ForgeRepoRef, number: number): Promise<ForgeFileDiff[]>;
  listReviewThreads(repo: ForgeRepoRef, number: number): Promise<ForgeReviewThread[]>;
  replyToThread(
    repo: ForgeRepoRef,
    number: number,
    replyTargetId: string,
    body: string,
  ): Promise<void>;
  resolveThread(
    repo: ForgeRepoRef,
    number: number,
    threadId: string,
    resolved: boolean,
  ): Promise<void>;
  submitReview(repo: ForgeRepoRef, number: number, opts: SubmitReviewOptions): Promise<void>;
  mergePullRequest(
    repo: ForgeRepoRef,
    number: number,
    opts: MergePullRequestOptions,
  ): Promise<MergeResult>;
  updatePullRequestState(
    repo: ForgeRepoRef,
    number: number,
    state: 'open' | 'closed',
  ): Promise<void>;
  updateBranch(repo: ForgeRepoRef, number: number): Promise<void>;
  listIssues(repo: ForgeRepoRef, state: ForgeStateFilter): Promise<ForgeIssueSummary[]>;
  getIssue(repo: ForgeRepoRef, number: number): Promise<ForgeIssueDetail>;
  addIssueComment(repo: ForgeRepoRef, number: number, body: string): Promise<void>;
  updateIssueState(repo: ForgeRepoRef, number: number, state: 'open' | 'closed'): Promise<void>;
  createIssue(repo: ForgeRepoRef, opts: CreateIssueOptions): Promise<ForgeIssueSummary>;
  listWorkflowRuns(repo: ForgeRepoRef, opts?: { branch?: string }): Promise<ForgeWorkflowRun[]>;
  getWorkflowRunJobs(repo: ForgeRepoRef, runId: number): Promise<ForgeWorkflowJob[]>;
  rerunWorkflowRun(repo: ForgeRepoRef, runId: number, opts?: { failedOnly?: boolean }): Promise<void>;
  cancelWorkflowRun(repo: ForgeRepoRef, runId: number): Promise<void>;
  getJobLog(repo: ForgeRepoRef, jobId: number): Promise<ForgeJobLog>;
  /** Verify an inbound webhook's signature over the exact raw request body. */
  verifyWebhookSignature(headers: Record<string, string | undefined>, rawBody: string): boolean;
  /** Map a raw webhook payload to a normalized event, or null if not actionable. */
  parseWebhookEvent(
    headers: Record<string, string | undefined>,
    payload: unknown,
  ): ForgeWebhookEvent | null;
  bustCache(): void;
}
