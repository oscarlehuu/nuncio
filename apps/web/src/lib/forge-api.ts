// Client for the repo-scoped forge API (/api/forge/...). A project is
// identified by `path` — the session's worktree/project path or any repo path.

export interface ForgeCapabilitiesDto {
  provider: string;
  connected: boolean;
  authMethod: 'token' | 'cli' | null;
  requestChanges: boolean;
  rebaseMerge: boolean;
  mergeWhenChecksPass: boolean;
  resolveThreads: boolean;
  updateBranch: boolean;
  rerunFailedOnly: boolean;
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
  commentCount: number | null;
}

export type ForgeMergeableState = 'mergeable' | 'conflicts' | 'blocked' | 'behind' | 'unknown';
export type ForgeReviewDecision = 'approved' | 'changes_requested' | 'review_required';

export interface ForgeCheckDto {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface ForgePullRequestDetail {
  number: number;
  url: string;
  state: string;
  title: string;
  body: string;
  author: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  mergeable: ForgeMergeableState;
  reviewDecision: ForgeReviewDecision | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: ForgeCheckDto[];
}

export interface ForgeFileDiff {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface ForgeComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ForgeReviewThread {
  id: string;
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
export type ForgeReviewEvent = 'approve' | 'request_changes' | 'comment';

export interface MergeResult {
  merged: boolean;
  sha: string | null;
  message: string;
}

async function forgeFetch<T>(url: string, init?: RequestInit, fallback = 'Forge request failed'): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? fallback);
  }
  return res.json() as Promise<T>;
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const q = (path: string) => `path=${encodeURIComponent(path)}`;

export function fetchForgeCapabilities(path: string): Promise<ForgeCapabilitiesDto> {
  return forgeFetch(`/api/forge/capabilities?${q(path)}`, undefined, 'Failed to load forge capabilities');
}

export function fetchForgePulls(path: string, state: ForgeStateFilter): Promise<ForgePullRequestSummary[]> {
  return forgeFetch(`/api/forge/pulls?${q(path)}&state=${state}`, undefined, 'Failed to load pull requests');
}

export function fetchForgePull(path: string, number: number): Promise<ForgePullRequestDetail> {
  return forgeFetch(`/api/forge/pulls/${number}?${q(path)}`, undefined, 'Failed to load pull request');
}

export function fetchForgePullFiles(path: string, number: number): Promise<ForgeFileDiff[]> {
  return forgeFetch(`/api/forge/pulls/${number}/files?${q(path)}`, undefined, 'Failed to load changed files');
}

export function fetchForgeThreads(path: string, number: number): Promise<ForgeReviewThread[]> {
  return forgeFetch(`/api/forge/pulls/${number}/threads?${q(path)}`, undefined, 'Failed to load review threads');
}

export function replyForgeThread(
  path: string,
  number: number,
  replyTargetId: string,
  body: string,
): Promise<{ ok: boolean }> {
  return forgeFetch(
    `/api/forge/pulls/${number}/threads/${encodeURIComponent(replyTargetId)}/reply?${q(path)}`,
    post({ body }),
    'Failed to reply to thread',
  );
}

export function resolveForgeThread(
  path: string,
  number: number,
  threadId: string,
  resolved: boolean,
): Promise<{ ok: boolean }> {
  return forgeFetch(
    `/api/forge/pulls/${number}/threads/${encodeURIComponent(threadId)}/resolve?${q(path)}`,
    post({ resolved }),
    'Failed to update thread',
  );
}

export function submitForgeReview(
  path: string,
  number: number,
  event: ForgeReviewEvent,
  body?: string,
): Promise<{ ok: boolean }> {
  return forgeFetch(
    `/api/forge/pulls/${number}/review?${q(path)}`,
    post({ event, body }),
    'Failed to submit review',
  );
}

export function addForgePullComment(path: string, number: number, body: string): Promise<{ ok: boolean }> {
  return forgeFetch(
    `/api/forge/pulls/${number}/comment?${q(path)}`,
    post({ body }),
    'Failed to add comment',
  );
}

export interface MergeForgePullOptions {
  method: ForgeMergeMethod;
  deleteSourceBranch?: boolean;
  mergeWhenChecksPass?: boolean;
  commitTitle?: string;
  commitMessage?: string;
}

export function mergeForgePull(
  path: string,
  number: number,
  opts: MergeForgePullOptions,
): Promise<MergeResult> {
  return forgeFetch(`/api/forge/pulls/${number}/merge?${q(path)}`, post(opts), 'Failed to merge');
}

export function setForgePullState(
  path: string,
  number: number,
  state: 'open' | 'closed',
): Promise<{ ok: boolean }> {
  return forgeFetch(
    `/api/forge/pulls/${number}/state?${q(path)}`,
    post({ state }),
    'Failed to update pull request',
  );
}

export function updateForgeBranch(path: string, number: number): Promise<{ ok: boolean }> {
  return forgeFetch(
    `/api/forge/pulls/${number}/update-branch?${q(path)}`,
    post({}),
    'Failed to update branch',
  );
}

export function fetchForgeIssues(path: string, state: ForgeStateFilter): Promise<ForgeIssueSummary[]> {
  return forgeFetch(`/api/forge/issues?${q(path)}&state=${state}`, undefined, 'Failed to load issues');
}

export function fetchForgeIssue(path: string, number: number): Promise<ForgeIssueDetail> {
  return forgeFetch(`/api/forge/issues/${number}?${q(path)}`, undefined, 'Failed to load issue');
}

export function addForgeIssueComment(path: string, number: number, body: string): Promise<{ ok: boolean }> {
  return forgeFetch(
    `/api/forge/issues/${number}/comment?${q(path)}`,
    post({ body }),
    'Failed to comment on issue',
  );
}

export function setForgeIssueState(
  path: string,
  number: number,
  state: 'open' | 'closed',
): Promise<{ ok: boolean }> {
  return forgeFetch(
    `/api/forge/issues/${number}/state?${q(path)}`,
    post({ state }),
    'Failed to update issue',
  );
}

export function createForgeIssue(
  path: string,
  opts: { title: string; body: string; labels?: string[] },
): Promise<ForgeIssueSummary> {
  return forgeFetch(`/api/forge/issues?${q(path)}`, post(opts), 'Failed to create issue');
}

export type ForgeRunStatus = 'queued' | 'running' | 'completed';

export interface ForgeWorkflowRun {
  id: number;
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
  steps: ForgeWorkflowStep[];
}

export interface ForgeJobLog {
  log: string;
  truncated: boolean;
}

export function fetchForgeRuns(path: string, branch?: string): Promise<ForgeWorkflowRun[]> {
  const branchQuery = branch ? `&branch=${encodeURIComponent(branch)}` : '';
  return forgeFetch(`/api/forge/runs?${q(path)}${branchQuery}`, undefined, 'Failed to load workflow runs');
}

export function fetchForgeRunJobs(path: string, runId: number): Promise<ForgeWorkflowJob[]> {
  return forgeFetch(`/api/forge/runs/${runId}/jobs?${q(path)}`, undefined, 'Failed to load run jobs');
}

export function rerunForgeRun(
  path: string,
  runId: number,
  failedOnly?: boolean,
): Promise<{ ok: boolean }> {
  return forgeFetch(`/api/forge/runs/${runId}/rerun?${q(path)}`, post({ failedOnly }), 'Failed to re-run');
}

export function cancelForgeRun(path: string, runId: number): Promise<{ ok: boolean }> {
  return forgeFetch(`/api/forge/runs/${runId}/cancel?${q(path)}`, post({}), 'Failed to cancel run');
}

export function fetchForgeJobLog(path: string, jobId: number): Promise<ForgeJobLog> {
  return forgeFetch(`/api/forge/jobs/${jobId}/log?${q(path)}`, undefined, 'Failed to load job log');
}
