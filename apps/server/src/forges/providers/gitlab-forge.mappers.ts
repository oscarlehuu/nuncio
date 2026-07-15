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

export interface GitlabMrSummaryResponse {
  iid: number;
  title: string;
  state: string;
  draft?: boolean;
  author?: { username?: string };
  source_branch?: string;
  target_branch?: string;
  web_url: string;
  updated_at?: string;
  user_notes_count?: number;
}

export interface GitlabMrDetailResponse extends GitlabMrSummaryResponse {
  description?: string | null;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  changes_count?: string | null;
  merge_commit_sha?: string | null;
  sha?: string | null;
  source_project_id?: number;
  target_project_id?: number;
}

export interface GitlabDiffResponse {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff?: string;
}

export interface GitlabNoteResponse {
  id: number;
  type?: string | null;
  body?: string;
  author?: { username?: string };
  created_at?: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: { new_path?: string | null; new_line?: number | null; old_line?: number | null };
}

export interface GitlabDiscussionResponse {
  id: string;
  individual_note?: boolean;
  notes?: GitlabNoteResponse[];
}

export interface GitlabIssueResponse {
  iid: number;
  title: string;
  state: string;
  author?: { username?: string };
  labels?: string[];
  assignees?: Array<{ username?: string }>;
  user_notes_count?: number;
  updated_at?: string;
  web_url: string;
  description?: string | null;
}

/** GitLab says 'opened'; the normalized vocabulary says 'open'. */
export function normalizeGitlabState(state: string): string {
  return state === 'opened' ? 'open' : state;
}

export function mapGitlabMrSummary(data: GitlabMrSummaryResponse): ForgePullRequestSummary {
  return {
    number: data.iid,
    title: data.title,
    state: normalizeGitlabState(data.state),
    draft: data.draft ?? false,
    author: data.author?.username ?? '',
    sourceBranch: data.source_branch ?? '',
    targetBranch: data.target_branch ?? '',
    url: data.web_url,
    updatedAt: data.updated_at ?? '',
    commentCount: data.user_notes_count ?? 0,
  };
}

export function mapGitlabMergeable(data: GitlabMrDetailResponse): ForgeMergeableState {
  if (data.has_conflicts) return 'conflicts';
  switch (data.detailed_merge_status) {
    case 'mergeable':
      return 'mergeable';
    case 'conflict':
      return 'conflicts';
    case 'need_rebase':
      return 'behind';
    case 'checking':
    case 'unchecked':
      return 'unknown';
    default:
      return 'blocked';
  }
}

export function mapGitlabPullDetail(
  data: GitlabMrDetailResponse,
  approved: boolean,
): ForgePullRequestDetail {
  const reviewDecision: ForgeReviewDecision | null = approved
    ? 'approved'
    : data.detailed_merge_status === 'requested_changes'
      ? 'changes_requested'
      : data.detailed_merge_status === 'not_approved'
        ? 'review_required'
        : null;
  return {
    number: data.iid,
    url: data.web_url,
    state: normalizeGitlabState(data.state),
    title: data.title,
    body: data.description ?? '',
    author: data.author?.username ?? '',
    draft: data.draft ?? false,
    sourceBranch: data.source_branch ?? '',
    sourceRepositoryMatchesTarget: Boolean(
      Number.isInteger(data.source_project_id) &&
      Number.isInteger(data.target_project_id) &&
      data.source_project_id === data.target_project_id,
    ),
    targetBranch: data.target_branch ?? '',
    mergeable: mapGitlabMergeable(data),
    reviewDecision,
    additions: 0, // GitLab REST does not report MR-level totals
    deletions: 0,
    changedFiles: Number.parseInt(data.changes_count ?? '0', 10) || 0,
  };
}

export function mapGitlabFileDiff(data: GitlabDiffResponse): ForgeFileDiff {
  const diff = data.diff ?? '';
  const lines = diff.split('\n');
  const additions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const deletions = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return {
    path: data.new_path ?? data.old_path ?? '',
    oldPath: data.renamed_file ? (data.old_path ?? null) : null,
    status: data.new_file
      ? 'added'
      : data.deleted_file
        ? 'removed'
        : data.renamed_file
          ? 'renamed'
          : 'modified',
    additions,
    deletions,
    patch: diff && !diff.startsWith('Binary files') ? diff : null,
  };
}

export function mapGitlabNote(note: GitlabNoteResponse): ForgeComment {
  return {
    id: String(note.id),
    author: note.author?.username ?? '',
    body: note.body ?? '',
    createdAt: note.created_at ?? '',
  };
}

/**
 * A discussion is a review thread when it is not an "individual note" (plain
 * MR comment) — i.e. someone started a thread, usually anchored to a diff line.
 */
export function mapGitlabDiscussion(data: GitlabDiscussionResponse): ForgeReviewThread | null {
  const notes = (data.notes ?? []).filter((note) => !note.system);
  if (notes.length === 0 || data.individual_note) return null;
  const resolvableNotes = notes.filter((note) => note.resolvable);
  const position = notes[0]?.position;
  return {
    id: data.id,
    replyTargetId: data.id,
    resolved:
      resolvableNotes.length > 0 ? resolvableNotes.every((note) => note.resolved === true) : null,
    resolvable: resolvableNotes.length > 0,
    path: position?.new_path ?? null,
    line: position?.new_line ?? position?.old_line ?? null,
    outdated: false, // GitLab REST does not expose thread outdatedness
    comments: notes.map(mapGitlabNote),
  };
}

export interface GitlabPipelineListResponse {
  id: number;
  status?: string;
  ref?: string;
  sha?: string;
  source?: string;
  web_url: string;
  created_at?: string;
}

export interface GitlabPipelineJobResponse {
  id: number;
  name: string;
  stage?: string;
  status?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export function mapGitlabRunStatus(status: string | undefined): {
  status: ForgeRunStatus;
  conclusion: string | null;
} {
  switch (status) {
    case 'success':
      return { status: 'completed', conclusion: 'success' };
    case 'failed':
      return { status: 'completed', conclusion: 'failure' };
    case 'canceled':
      return { status: 'completed', conclusion: 'cancelled' };
    case 'skipped':
      return { status: 'completed', conclusion: 'skipped' };
    case 'running':
      return { status: 'running', conclusion: null };
    case 'manual':
      return { status: 'queued', conclusion: 'manual' };
    default:
      // created / pending / preparing / waiting_for_resource / scheduled
      return { status: 'queued', conclusion: null };
  }
}

export function mapGitlabPipeline(data: GitlabPipelineListResponse): ForgeWorkflowRun {
  const { status, conclusion } = mapGitlabRunStatus(data.status);
  return {
    id: data.id,
    name: `Pipeline #${data.id}`,
    runNumber: null,
    status,
    conclusion,
    branch: data.ref ?? '',
    sha: data.sha ?? '',
    event: data.source ?? '',
    actor: '', // GitLab's pipeline list does not include the triggering user
    url: data.web_url,
    createdAt: data.created_at ?? '',
    durationSeconds: null, // only the pipeline detail endpoint reports duration
  };
}

export function mapGitlabPipelineJob(data: GitlabPipelineJobResponse): ForgeWorkflowJob {
  const { status, conclusion } = mapGitlabRunStatus(data.status);
  return {
    id: data.id,
    name: data.stage ? `${data.stage}: ${data.name}` : data.name,
    status,
    conclusion,
    startedAt: data.started_at ?? null,
    completedAt: data.finished_at ?? null,
    steps: [], // GitLab REST has no per-step breakdown
  };
}

export function mapGitlabIssueSummary(data: GitlabIssueResponse): ForgeIssueSummary {
  return {
    number: data.iid,
    title: data.title,
    state: normalizeGitlabState(data.state),
    author: data.author?.username ?? '',
    labels: data.labels ?? [],
    assignees: (data.assignees ?? []).map((a) => a.username ?? '').filter(Boolean),
    commentCount: data.user_notes_count ?? 0,
    updatedAt: data.updated_at ?? '',
    url: data.web_url,
  };
}
