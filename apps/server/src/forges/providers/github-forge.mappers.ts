import type {
  ForgeComment,
  ForgeFileDiff,
  ForgeIssueSummary,
  ForgeMergeableState,
  ForgePullRequestDetail,
  ForgePullRequestSummary,
  ForgeReviewDecision,
  ForgeReviewThread,
  ForgeRunStatus,
  ForgeWorkflowJob,
  ForgeWorkflowRun,
} from '../forges.types';

export interface GithubPullSummaryResponse {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  user?: { login?: string };
  head?: { ref?: string; repo?: { full_name?: string } };
  base?: { ref?: string; repo?: { full_name?: string } };
  html_url: string;
  updated_at?: string;
}

export interface GithubPullDetailResponse extends GithubPullSummaryResponse {
  body?: string | null;
  merged?: boolean;
  mergeable_state?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export interface GithubFileResponse {
  filename: string;
  previous_filename?: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

export interface GithubCommentResponse {
  id: number;
  user?: { login?: string };
  body?: string;
  created_at?: string;
}

export interface GithubIssueResponse {
  number: number;
  title: string;
  state: string;
  user?: { login?: string };
  labels?: Array<{ name?: string }>;
  assignees?: Array<{ login?: string }>;
  comments?: number;
  updated_at?: string;
  html_url: string;
  body?: string | null;
  pull_request?: unknown;
}

export interface GithubThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments?: {
    nodes?: Array<{
      databaseId: number | null;
      author?: { login?: string } | null;
      body?: string;
      createdAt?: string;
    }>;
  };
}

export function mapGithubPullSummary(data: GithubPullSummaryResponse): ForgePullRequestSummary {
  return {
    number: data.number,
    title: data.title,
    state: data.merged_at ? 'merged' : data.state,
    draft: data.draft ?? false,
    author: data.user?.login ?? '',
    sourceBranch: data.head?.ref ?? '',
    targetBranch: data.base?.ref ?? '',
    url: data.html_url,
    updatedAt: data.updated_at ?? '',
    commentCount: null, // GitHub's list endpoint has no comment count
  };
}

export function mapGithubMergeable(state: string | undefined): ForgeMergeableState {
  switch (state) {
    case 'clean':
    case 'has_hooks':
    case 'unstable':
      return 'mergeable';
    case 'dirty':
      return 'conflicts';
    case 'blocked':
    case 'draft':
      return 'blocked';
    case 'behind':
      return 'behind';
    default:
      return 'unknown';
  }
}

export function mapGithubReviewDecision(decision: string | null): ForgeReviewDecision | null {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      return null;
  }
}

export function mapGithubPullDetail(
  data: GithubPullDetailResponse,
  reviewDecision: ForgeReviewDecision | null,
): ForgePullRequestDetail {
  return {
    number: data.number,
    url: data.html_url,
    state: data.merged || data.merged_at ? 'merged' : data.state,
    title: data.title,
    body: data.body ?? '',
    author: data.user?.login ?? '',
    draft: data.draft ?? false,
    sourceBranch: data.head?.ref ?? '',
    sourceRepositoryMatchesTarget: Boolean(
      data.head?.repo?.full_name &&
      data.base?.repo?.full_name &&
      data.head.repo.full_name.toLowerCase() === data.base.repo.full_name.toLowerCase(),
    ),
    targetBranch: data.base?.ref ?? '',
    mergeable: mapGithubMergeable(data.mergeable_state),
    reviewDecision,
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    changedFiles: data.changed_files ?? 0,
  };
}

export function mapGithubFileDiff(data: GithubFileResponse): ForgeFileDiff {
  const status =
    data.status === 'added' || data.status === 'copied'
      ? 'added'
      : data.status === 'removed'
        ? 'removed'
        : data.status === 'renamed'
          ? 'renamed'
          : 'modified';
  return {
    path: data.filename,
    oldPath: data.previous_filename ?? null,
    status,
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    patch: data.patch ?? null,
  };
}

export function mapGithubComment(data: GithubCommentResponse): ForgeComment {
  return {
    id: String(data.id),
    author: data.user?.login ?? '',
    body: data.body ?? '',
    createdAt: data.created_at ?? '',
  };
}

export function mapGithubIssueSummary(data: GithubIssueResponse): ForgeIssueSummary {
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    author: data.user?.login ?? '',
    labels: (data.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
    assignees: (data.assignees ?? []).map((a) => a.login ?? '').filter(Boolean),
    commentCount: data.comments ?? 0,
    updatedAt: data.updated_at ?? '',
    url: data.html_url,
  };
}

export interface GithubWorkflowRunResponse {
  id: number;
  name?: string | null;
  run_number?: number;
  status?: string;
  conclusion?: string | null;
  head_branch?: string | null;
  head_sha?: string;
  event?: string;
  actor?: { login?: string };
  html_url: string;
  created_at?: string;
  run_started_at?: string;
  updated_at?: string;
}

export interface GithubWorkflowJobResponse {
  id: number;
  name: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: Array<{ name: string; status?: string; conclusion?: string | null }>;
}

export function mapGithubRunStatus(status: string | undefined): ForgeRunStatus {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress') return 'running';
  return 'queued';
}

export function mapGithubWorkflowRun(data: GithubWorkflowRunResponse): ForgeWorkflowRun {
  const started = data.run_started_at ? Date.parse(data.run_started_at) : NaN;
  const updated = data.updated_at ? Date.parse(data.updated_at) : NaN;
  const completed = data.status === 'completed';
  return {
    id: data.id,
    name: data.name ?? `Run ${data.id}`,
    runNumber: data.run_number ?? null,
    status: mapGithubRunStatus(data.status),
    conclusion: data.conclusion ?? null,
    branch: data.head_branch ?? '',
    sha: data.head_sha ?? '',
    event: data.event ?? '',
    actor: data.actor?.login ?? '',
    url: data.html_url,
    createdAt: data.created_at ?? '',
    durationSeconds:
      completed && Number.isFinite(started) && Number.isFinite(updated) && updated >= started
        ? Math.round((updated - started) / 1000)
        : null,
  };
}

export function mapGithubWorkflowJob(data: GithubWorkflowJobResponse): ForgeWorkflowJob {
  return {
    id: data.id,
    name: data.name,
    status: mapGithubRunStatus(data.status),
    conclusion: data.conclusion ?? null,
    startedAt: data.started_at ?? null,
    completedAt: data.completed_at ?? null,
    steps: (data.steps ?? []).map((step) => ({
      name: step.name,
      status: mapGithubRunStatus(step.status),
      conclusion: step.conclusion ?? null,
    })),
  };
}

export function mapGithubThread(node: GithubThreadNode): ForgeReviewThread {
  const comments = (node.comments?.nodes ?? []).map((comment) => ({
    id: comment.databaseId != null ? String(comment.databaseId) : '',
    author: comment.author?.login ?? '',
    body: comment.body ?? '',
    createdAt: comment.createdAt ?? '',
  }));
  return {
    id: node.id,
    // Replies target the thread's first comment via its REST database id.
    replyTargetId: comments[0]?.id || null,
    resolved: node.isResolved,
    resolvable: true,
    path: node.path,
    line: node.line,
    outdated: node.isOutdated,
    comments,
  };
}
