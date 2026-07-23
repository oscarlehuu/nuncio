import { apiFetch } from './http';
import type { ModelProvider } from './model-providers';
import type { ModelOptionsMap } from './model-options';
import { normalizeModelCatalog } from './model-providers';

export type { UserInputAnswer, InteractionResponse, PendingUserInput, UserInputQuestion, UserInputOption, UserInputResolvedBy } from './user-input.types';
import type { InteractionResponse } from './user-input.types';
export type { ImageAttachment, MessageAttachment, TranscriptImage } from './attachments';
export { isImageAttachment, attachmentDataUrl, transcriptImageSrc } from './attachments';
import type { MessageAttachment } from './attachments';

export type SessionStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'IDLE'
  | 'PAUSED'
  | 'ARCHIVED'
  | 'ERROR';

/** Session modes (capability-gated per provider via `capabilities.modes`). */
export type SessionMode = 'debug' | 'multitask';

export interface GitFileChange {
  path: string;
  index: string;
  workTree: string;
  staged: boolean;
  insertions: number;
  deletions: number;
}

export interface GitStatusDto {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitFileChange[];
}

export interface GitCommitDto {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authoredAt: string;
}

export interface GitUnpushedCommitsDto {
  branch: string;
  base: string | null;
  commits: GitCommitDto[];
}

export interface GitBranchSyncDto {
  branch: string;
  base: string | null;
  ahead: number;
  behind: number;
  outgoing: GitCommitDto[];
  incoming: GitCommitDto[];
  conflicts: string[];
  clean: boolean;
}

export interface GitStashEntryDto {
  index: number;
  message: string;
  sha: string;
}

export interface GitBlameLineDto {
  line: number;
  sha: string;
  shortSha: string;
  authorName: string;
  authoredAt: string;
  content: string;
}

export interface GitBlameDto {
  path: string;
  lines: GitBlameLineDto[];
  truncated: boolean;
}

export interface GitHistoryCommitDto extends GitCommitDto {
  parents: string[];
}

export interface GitHistoryDto {
  branch: string;
  commits: GitHistoryCommitDto[];
}

export interface PullResultDto {
  pulled: boolean;
  fastForward: boolean;
}

export interface GitDiffDto {
  diff: string;
  truncated: boolean;
}

export interface CommitResultDto {
  sha: string;
  committed: boolean;
}

export interface PushResultDto {
  pushed: boolean;
  remoteBranch: string;
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
  checks?: ForgeCheck[];
}

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  provider: string;
  model: string | null;
  modelOptions: ModelOptionsMap | null;
  /** Session mode (e.g. 'debug', 'multitask'); null = normal agent. */
  mode: SessionMode | null;
  prompt: string;
  preview: string | null;
  workspace: string | null;
  projectPath: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  branch: string | null;
  /**
   * Repo-grouping identity (RepoIdentity.id) for the session's working dir, so
   * clients group all worktrees of one repo under a single project. Null when the
   * session has no project/workspace or it is a non-git folder → the client falls
   * back to path grouping. Optional so responses from an older server still parse.
   */
  repoIdentityId?: string | null;
  /** The owning repository's main working tree; null for non-git / no project. */
  repoRoot?: string | null;
  /** True when the session runs in a LINKED worktree rather than the main checkout. */
  isWorktree?: boolean;
  cursorBackend: 'sdk' | 'cli' | null;
  cursorChatId: string | null;
  forgeProvider?: string | null;
  pullRequestUrl?: string | null;
  pullRequestNumber?: number | null;
  pullRequestState?: string | null;
  forgeStatus?: string;
  /** False when the stored provider id is not registered in this build. */
  providerAvailable?: boolean;
  supportsInteraction: boolean;
  supportsInterrupt?: boolean;
  supportsSteerWhileRunning?: boolean;
  /** Provider accepts image attachments on prompts/steers (capability-gated UI). */
  supportsImages?: boolean;
  /** Agent is blocked on an open user-input or approval request (RUNNING only). */
  pendingInput?: boolean;
  /** Which layer owns the verify gate for this session. */
  verifyOwner?: 'session';
  parentSessionId?: string | null;
  originTaskId?: string | null;
  priorSessionId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export type ProviderRequestDecision = 'approve' | 'deny';

export type TaskStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
export type TaskRole = 'standalone' | 'subagent';
export type TaskCleanupPolicy = 'after-review' | 'manual' | 'never';
export type TaskReviewState = 'awaiting_review' | 'reviewed';

export interface WorkspaceSnapshot {
  branch: string | null;
  headSha: string | null;
  baseBranch: string | null;
  dirtyFiles: string[];
  diffStat: string | null;
}

export interface HandoffBrief {
  goal: string;
  constraints?: string[];
  decisions?: string[];
  files?: string[];
  verifyCommand?: string;
  doneCriteria?: string[];
  workspace?: WorkspaceSnapshot | null;
  sourceSessionId?: string;
  sourceSeq?: number;
}

export interface TaskDto {
  id: string;
  prompt: string;
  status: TaskStatus;
  provider: string | null;
  model: string | null;
  modelOptions: ModelOptionsMap | null;
  projectPath: string | null;
  baseBranch: string | null;
  useWorktree: boolean;
  workspace: string | null;
  parentSessionId: string | null;
  role: TaskRole;
  cleanupPolicy: TaskCleanupPolicy | null;
  reviewState: TaskReviewState | null;
  sessionId: string | null;
  outcome: Record<string, unknown> | null;
  contextBrief?: HandoffBrief | null;
  pendingInput?: boolean;
  holdUntil: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface StartMultitaskInput {
  parentSessionId: string;
  prompts: string[];
  provider?: string;
  model?: string;
  modelOptions?: ModelOptionsMap | null;
  projectPath?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  workspace?: string;
  cleanupPolicy?: TaskCleanupPolicy;
  contextBrief?: HandoffBrief;
}

export interface StartMultitaskResult {
  parentSessionId: string;
  tasks: TaskDto[];
}

export interface SessionRef {
  id: string;
  title: string;
  status: SessionStatus;
  provider: string;
}

export interface SessionLineage {
  ancestors: SessionRef[];
  children: SessionRef[];
}

export class SteerApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SteerApiError';
    this.status = status;
  }
}

export class InteractionApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'InteractionApiError';
    this.status = status;
  }
}

export function steerErrorMessage(status: number, fallback: string): string {
  switch (status) {
    case 409:
      return 'Cursor is still running this chat on your Mac. Pause it there, then retry — or force steer anyway.';
    case 503:
      return 'Cursor CLI not found. Install it or set NUNCIO_CURSOR_AGENT_BIN in Settings.';
    default:
      return fallback;
  }
}

export function interactionErrorMessage(status: number, fallback: string): string {
  if (status === 501) {
    return 'Answering from phone is not yet supported for this provider.';
  }
  return fallback;
}

export interface ActiveRunStatus {
  active: boolean;
}

export async function fetchActiveRun(sessionId: string): Promise<ActiveRunStatus> {
  const res = await apiFetch(`/api/sessions/${sessionId}/active-run`);
  if (!res.ok) throw new Error('Failed to check active run status');
  return res.json();
}

export async function refreshSessionTranscript(sessionId: string): Promise<{ added: number }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/refresh-transcript`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to refresh transcript');
  return res.json();
}

export async function fetchSessions(base = ''): Promise<Session[]> {
  const res = await apiFetch(`${base}/api/sessions`);
  if (!res.ok) throw new Error('Failed to load sessions');
  return res.json();
}

export async function fetchSession(id: string, base = ''): Promise<Session> {
  const res = await apiFetch(`${base}/api/sessions/${id}`);
  // Status in the message lets callers tell "gone" (404) from an outage.
  if (!res.ok) throw new Error(`Failed to load session (${res.status})`);
  return res.json();
}

export async function fetchArchivedSessions(): Promise<Session[]> {
  const res = await apiFetch('/api/sessions?includeArchived=1');
  if (!res.ok) throw new Error('Failed to load archived sessions');
  const all = (await res.json()) as Session[];
  return all.filter((s) => s.status === 'ARCHIVED');
}

export async function createSession(
  prompt: string,
  model?: string,
  provider?: string,
  projectPath?: string,
  baseBranch?: string,
  modelOptions?: ModelOptionsMap,
  useWorktree = false,
  base = '',
  attachments?: MessageAttachment[],
  mode?: SessionMode,
  mcpServerIds?: string[],
): Promise<Session> {
  const body: {
    prompt: string;
    model?: string;
    provider?: string;
    workspace?: string;
    projectPath?: string;
    baseBranch?: string;
    modelOptions?: ModelOptionsMap;
    useWorktree?: boolean;
    attachments?: MessageAttachment[];
    mode?: SessionMode;
    mcpServerIds?: string[];
  } = { prompt };
  if (model) body.model = model;
  if (provider) body.provider = provider;
  if (mode) body.mode = mode;
  if (projectPath) {
    body.projectPath = projectPath;
    if (baseBranch) body.baseBranch = baseBranch;
    if (useWorktree) {
      body.useWorktree = true;
    } else {
      body.workspace = projectPath;
    }
  }
  if (modelOptions && Object.keys(modelOptions).length > 0) body.modelOptions = modelOptions;
  if (attachments && attachments.length > 0) body.attachments = attachments;
  if (mcpServerIds && mcpServerIds.length > 0) body.mcpServerIds = mcpServerIds;

  const res = await apiFetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Failed to create session');
  return res.json();
}

export async function steerSession(
  id: string,
  message: string,
  forceResume?: boolean,
  base = '',
  attachments?: MessageAttachment[],
): Promise<Session> {
  const body: { message: string; forceResume?: boolean; attachments?: MessageAttachment[] } = {
    message,
  };
  if (forceResume) body.forceResume = true;
  if (attachments && attachments.length > 0) body.attachments = attachments;

  const res = await apiFetch(`${base}/api/sessions/${id}/steer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      // keep raw text
    }
    throw new SteerApiError(
      res.status,
      steerErrorMessage(res.status, detail || 'Failed to steer session'),
    );
  }
  return res.json();
}

export async function respondInteraction(
  sessionId: string,
  requestId: string,
  response: InteractionResponse,
): Promise<{ ok: true }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/interactions/${requestId}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(response),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      detail = parsed.message ?? parsed.error ?? detail;
    } catch {
      // keep raw text
    }
    throw new InteractionApiError(
      res.status,
      interactionErrorMessage(res.status, detail || 'Failed to submit response'),
    );
  }
  return res.json();
}

export async function pauseSession(id: string): Promise<Session> {
  const res = await apiFetch(`/api/sessions/${id}/pause`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to pause session');
  return res.json();
}

/** Abort the live run in place — session lands IDLE with partial output kept. */
export async function interruptSession(id: string): Promise<void> {
  const res = await apiFetch(`/api/sessions/${id}/interrupt`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to interrupt session');
}

export async function archiveSession(id: string): Promise<Session> {
  const res = await apiFetch(`/api/sessions/${id}/archive`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to archive session');
  return res.json();
}

export async function restoreSession(id: string): Promise<Session> {
  const res = await apiFetch(`/api/sessions/${id}/restore`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to restore session');
  return res.json();
}

export async function deleteSession(id: string): Promise<void> {
  const res = await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete session');
}

export async function respondProviderRequest(
  sessionId: string,
  requestId: string,
  decision: ProviderRequestDecision,
): Promise<{ requestId: string; decision: ProviderRequestDecision }> {
  const res = await apiFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/provider-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
  );
  if (!res.ok) throw new Error('Failed to respond to provider request');
  return res.json();
}

export async function renameSession(id: string, title: string): Promise<Session> {
  const res = await apiFetch(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error('Failed to rename session');
  return res.json();
}

export async function fetchModels(base = ''): Promise<ModelProvider[]> {
  try {
    const res = await apiFetch(`${base}/api/models`);
    if (!res.ok) return [];
    const data = await res.json();
    if (Array.isArray(data)) return normalizeModelCatalog(data as ModelProvider[]);
    if (Array.isArray(data?.providers)) return normalizeModelCatalog(data.providers as ModelProvider[]);
    return [];
  } catch {
    return [];
  }
}

export interface EventWindow {
  /** Last N events (newest window) — takes precedence over since/limit. */
  tail?: number;
  /** Page of events immediately preceding this seq (backfill). */
  before?: number;
  /** Max rows for since/before reads. */
  limit?: number;
}

export async function fetchEvents(
  sessionId: string,
  since = 0,
  base = '',
  window?: EventWindow,
): Promise<SessionEvent[]> {
  const params = new URLSearchParams({ since: String(since) });
  if (window?.tail !== undefined) params.set('tail', String(window.tail));
  if (window?.before !== undefined) params.set('before', String(window.before));
  if (window?.limit !== undefined) params.set('limit', String(window.limit));
  const res = await apiFetch(`${base}/api/sessions/${sessionId}/events?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to load events');
  return res.json();
}

export async function fetchSessionLineage(sessionId: string): Promise<SessionLineage> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/lineage`);
  if (!res.ok) throw new Error('Failed to load session lineage');
  return res.json();
}

export function statusLabel(status: SessionStatus): string {
  const map: Record<SessionStatus, string> = {
    CREATED: 'Created',
    RUNNING: 'Running',
    IDLE: 'Idle',
    PAUSED: 'Paused',
    ARCHIVED: 'Archived',
    ERROR: 'Error',
  };
  return map[status] ?? status;
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export async function fetchGitStatus(id: string): Promise<GitStatusDto> {
  const res = await apiFetch(`/api/sessions/${id}/git/status`);
  if (!res.ok) throw new Error('Failed to fetch Git status');
  return res.json();
}

export async function fetchUnpushedCommits(id: string): Promise<GitUnpushedCommitsDto> {
  const res = await apiFetch(`/api/sessions/${id}/git/unpushed`);
  if (!res.ok) throw new Error('Failed to fetch unpushed commits');
  return res.json();
}

export async function fetchGitBranchSync(id: string): Promise<GitBranchSyncDto> {
  const res = await apiFetch(`/api/sessions/${id}/git/sync`);
  if (!res.ok) throw new Error('Failed to fetch branch sync');
  return res.json();
}

export async function fetchCommitDiff(id: string, sha: string): Promise<GitDiffDto> {
  const res = await apiFetch(`/api/sessions/${id}/git/commits/${encodeURIComponent(sha)}/diff`);
  if (!res.ok) throw new Error('Failed to fetch commit diff');
  return res.json();
}

export async function fetchGitStash(id: string): Promise<GitStashEntryDto[]> {
  const res = await apiFetch(`/api/sessions/${id}/git/stash`);
  if (!res.ok) throw new Error('Failed to fetch stash');
  return res.json();
}

export async function fetchGitBlame(id: string, path: string): Promise<GitBlameDto> {
  const params = new URLSearchParams({ path });
  const res = await apiFetch(`/api/sessions/${id}/git/blame?${params}`);
  if (!res.ok) throw new Error('Failed to fetch blame');
  return res.json();
}

export async function fetchGitHistory(
  id: string,
  limitOrOptions?: number | { limit?: number; branch?: string },
): Promise<GitHistoryDto> {
  const options =
    typeof limitOrOptions === 'number' || limitOrOptions == null
      ? { limit: limitOrOptions }
      : limitOrOptions;
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.branch?.trim()) params.set('branch', options.branch.trim());
  const query = params.toString() ? `?${params}` : '';
  const res = await apiFetch(`/api/sessions/${id}/git/history${query}`);
  if (!res.ok) throw new Error('Failed to fetch history');
  return res.json();
}

export async function pullSession(id: string): Promise<PullResultDto> {
  const res = await apiFetch(`/api/sessions/${id}/git/pull`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to pull');
  return res.json();
}

export async function fetchGitDiff(
  id: string,
  opts?: { staged?: boolean; base?: string; path?: string },
): Promise<GitDiffDto> {
  const params = new URLSearchParams();
  if (opts?.staged) params.append('staged', '1');
  if (opts?.base) params.append('base', opts.base);
  if (opts?.path) params.append('path', opts.path);
  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`/api/sessions/${id}/git/diff${query}`);
  if (!res.ok) throw new Error('Failed to fetch Git diff');
  return res.json();
}

export async function commitSession(
  id: string,
  message: string,
  stageAll?: boolean,
): Promise<CommitResultDto> {
  const res = await apiFetch(`/api/sessions/${id}/git/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, stageAll }),
  });
  if (!res.ok) throw new Error('Failed to commit session');
  return res.json();
}

export interface HandoffToProviderInput {
  provider: string;
  model?: string;
  prompt?: string;
}

/**
 * Hand a settled session to another engine: the server creates a new session
 * on the target provider seeded with the source's compacted timeline and
 * working directory, linked via priorSessionId.
 */
export async function handoffSessionTo(
  id: string,
  input: HandoffToProviderInput,
): Promise<Session> {
  const res = await apiFetch(`/api/sessions/${id}/handoff-to`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? 'Failed to hand off session');
  }
  return res.json();
}

/**
 * Ask the server to draft a commit message for the session's working tree.
 * Generation goes through an engine's one-shot completion; the result only
 * prefills the message box — nothing is committed.
 */
export async function generateCommitMessage(id: string): Promise<{ message: string }> {
  const res = await apiFetch(`/api/sessions/${id}/git/commit-message`, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? 'Failed to generate a commit message');
  }
  return res.json();
}

export async function pushSession(
  id: string,
  opts?: { force?: boolean },
): Promise<PushResultDto> {
  const res = await apiFetch(`/api/sessions/${id}/git/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: opts?.force }),
  });
  if (!res.ok) throw new Error('Failed to push session');
  return res.json();
}

async function forgeErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
}

export async function openPullRequest(
  id: string,
  opts?: { title?: string; body?: string; draft?: boolean; base?: string },
): Promise<ForgePullRequest> {
  const res = await apiFetch(`/api/sessions/${id}/forge/pull-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(await forgeErrorMessage(res, 'Failed to open pull request'));
  return res.json();
}

export async function fetchPullRequest(id: string): Promise<ForgePullRequest> {
  const res = await apiFetch(`/api/sessions/${id}/forge/pull-request`);
  if (!res.ok) throw new Error(await forgeErrorMessage(res, 'Failed to fetch pull request'));
  return res.json();
}

/** Child subagent tasks spawned from a parent session's multitasking. */
export async function fetchChildTasks(parentSessionId: string): Promise<TaskDto[]> {
  const res = await apiFetch(
    `/api/tasks?parentSessionId=${encodeURIComponent(parentSessionId)}`,
  );
  if (!res.ok) throw new Error('Failed to load subagent tasks');
  return res.json();
}

/** Run one or more prompts as child subagents while the parent session continues. */
export async function startMultitask(input: StartMultitaskInput): Promise<StartMultitaskResult> {
  const res = await apiFetch('/api/tasks/multitask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to start multitasking');
  return res.json();
}

/** Fan the parent session's queued messages out as parallel subagents. */
export async function startMultitaskFromQueue(
  parentSessionId: string,
): Promise<StartMultitaskResult> {
  const res = await apiFetch('/api/tasks/multitask-from-queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentSessionId }),
  });
  if (!res.ok) throw new Error('Failed to start multitasking');
  return res.json();
}

/** Mark a subagent task that is awaiting review as reviewed. */
export async function markTaskReviewed(id: string): Promise<TaskDto> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/reviewed`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to mark task reviewed');
  return res.json();
}

/** Update a queued task's model/provider or re-arm its launch hold. */
export async function updateTask(
  id: string,
  input: { provider?: string; model?: string; modelOptions?: ModelOptionsMap | null; holdSeconds?: number },
): Promise<TaskDto> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to update task');
  return res.json();
}

/** Start a held task immediately, skipping the rest of its countdown. */
export async function startTaskNow(id: string): Promise<TaskDto> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/start-now`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to start task');
  return res.json();
}

/** Cancel a queued subagent task. */
export async function cancelTask(id: string): Promise<TaskDto> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to cancel task');
  return res.json();
}

/** Retry a finished task as a fresh queued run. */
export async function retryTask(id: string): Promise<TaskDto> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to retry task');
  return res.json();
}

// ── Autopilot: loops + project config (rung 2) ──────────────────────────────
// Loops are standing tasks fired on a schedule inside run-count budgets. The
// server keeps these UI-ready so the phone/fleet surfaces render straight off.

export type LoopStatus = 'active' | 'paused' | 'broken' | 'completed';
// 'pending' is the in-flight state a run is born in (task enqueued, not yet
// settled) — the most common outcome on an active loop, finalized to ok/failed.
// 'budget-exhausted' and 'skipped-overlap' are bookkeeping markers a fire writes
// when it does NOT enqueue (day budget spent / prior run still in flight); neither
// consumes a budget slot (see CONSUMED_OUTCOMES in loop-schedule.ts).
export type LoopRunOutcome =
  | 'pending'
  | 'ok'
  | 'failed'
  | 'budget-exhausted'
  | 'skipped-overlap'
  | 'resume';
export type LoopRunVerify = 'green' | 'red' | 'none';
export type ScheduleKind = 'cron' | 'heartbeat' | 'event';

export type StopCondition =
  | null
  | { kind: 'maxTotalRuns'; n: number }
  | { kind: 'verifyGreenN'; n: number };

export interface LoopDto {
  id: string;
  /** Optional human label (v1.1); null = fall back to the goal for display. */
  name: string | null;
  goal: string;
  scheduleId: string;
  /**
   * The human-displayable trigger, joined from the owned schedule row. Null (or
   * absent) when the schedule row is missing/corrupt — render nothing, never crash.
   */
  schedule?: { kind: string; spec: string } | null;
  /** Next fire time (epoch ms), joined from the schedule; null for event/none triggers. */
  nextFireAt?: number | null;
  maxRunsPerDay: number;
  maxConsecutiveFailures: number;
  stop: StopCondition;
  escalation: string;
  projectPath: string | null;
  /** Per-loop engine override; null = inherit from the project's default engine. */
  engine?: string | null;
  /** Per-loop model override; null = the resolved engine's default model. */
  model?: string | null;
  status: LoopStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateLoopInput {
  /** Optional human label; null/omitted → displayed as the goal. */
  name?: string | null;
  goal: string;
  schedule: { kind: ScheduleKind; spec: string };
  maxRunsPerDay?: number;
  maxConsecutiveFailures?: number;
  stop?: StopCondition;
  projectPath?: string;
  /** Per-loop engine override (provider id); null clears it. */
  engine?: string | null;
  /** Per-loop model override; requires a resolvable engine; null = engine default. */
  model?: string | null;
}

export interface LoopRunDto {
  id: string;
  loopId: string;
  taskId: string | null;
  outcome: LoopRunOutcome;
  verify: LoopRunVerify;
  dayBucket: string;
  createdAt: number;
}

/** Locked founder defaults — surfaced so the create form pre-fills them. */
export const DEFAULT_MAX_RUNS_PER_DAY = 24;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export async function fetchLoops(): Promise<LoopDto[]> {
  const res = await apiFetch('/api/loops');
  if (!res.ok) throw new Error('Failed to load loops');
  const data = (await res.json()) as { items?: LoopDto[] };
  return data.items ?? [];
}

export async function fetchLoop(id: string): Promise<LoopDto> {
  const res = await apiFetch(`/api/loops/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to load loop (${res.status})`);
  return res.json();
}

export async function createLoop(input: CreateLoopInput): Promise<LoopDto> {
  const res = await apiFetch('/api/loops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await loopErrorMessage(res, 'Failed to create loop'));
  return res.json();
}

export async function pauseLoop(id: string): Promise<LoopDto> {
  const res = await apiFetch(`/api/loops/${encodeURIComponent(id)}/pause`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to pause loop');
  return res.json();
}

/** Resume a paused OR broken loop (broken = "fix + resume": re-enables + zeroes the streak). */
export async function resumeLoop(id: string): Promise<LoopDto> {
  const res = await apiFetch(`/api/loops/${encodeURIComponent(id)}/resume`, { method: 'POST' });
  if (!res.ok) throw new Error(await loopErrorMessage(res, 'Failed to resume loop'));
  return res.json();
}

export async function deleteLoop(id: string): Promise<void> {
  const res = await apiFetch(`/api/loops/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete loop');
}

export async function fetchLoopRuns(id: string): Promise<LoopRunDto[]> {
  const res = await apiFetch(`/api/loops/${encodeURIComponent(id)}/runs`);
  if (!res.ok) throw new Error('Failed to load loop runs');
  const data = (await res.json()) as { items?: LoopRunDto[] };
  return data.items ?? [];
}

/** Editable loop fields (detail Settings tab). Patch semantics: omitted = unchanged. */
export interface UpdateLoopInput {
  /** null clears the label (display falls back to the goal). */
  name?: string | null;
  goal?: string;
  /** Re-spec the loop's owned trigger in place; run history/streaks survive. */
  schedule?: { kind: ScheduleKind; spec: string };
  /** null clears the per-loop engine override (inherit from project). */
  engine?: string | null;
  /** null clears the per-loop model override (the resolved engine's default). */
  model?: string | null;
  maxRunsPerDay?: number;
  /** Consecutive-failure breaker threshold (min 1). */
  maxConsecutiveFailures?: number;
  stop?: StopCondition;
}

export async function updateLoop(id: string, input: UpdateLoopInput): Promise<LoopDto> {
  const res = await apiFetch(`/api/loops/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await loopErrorMessage(res, 'Failed to save loop'));
  return res.json();
}

/** Why an immediate fire did nothing: a run was already in flight, or today's budget is spent. */
export type FireSkipReason = 'overlap' | 'budget';

/**
 * Result of POST /loops/:id/fire. 200 → the run started; 409 → the fire was
 * skipped and `reason` says which guard tripped (so the UI shows the truth instead
 * of a false "Run started"). Other non-2xx (a broken/paused/completed loop, network)
 * still throw — the button is disabled for those, so hitting one is a real error.
 */
export type FireLoopResult =
  | { fired: true; run: LoopRunDto }
  | { fired: false; reason: FireSkipReason };

export async function fireLoop(id: string): Promise<FireLoopResult> {
  const res = await apiFetch(`/api/loops/${encodeURIComponent(id)}/fire`, { method: 'POST' });
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { reason?: FireSkipReason } | null;
    // Default to 'overlap' if the server omitted a reason — the safer "still working" read.
    return { fired: false, reason: body?.reason === 'budget' ? 'budget' : 'overlap' };
  }
  if (!res.ok) throw new Error(await loopErrorMessage(res, 'Failed to run loop'));
  return { fired: true, run: await res.json() };
}

/** One run's full drill-down detail (GitHub-Actions-style run view). */
export interface LoopRunDetailDto extends LoopRunDto {
  /** The session that executed this run — deep-link into its transcript. */
  sessionId: string | null;
  durationMs: number | null;
  verifyOutputTail: string | null;
  failureReason: string | null;
  startedAt: number | null;
  settledAt: number | null;
}

export async function fetchLoopRunDetail(
  loopId: string,
  runId: string,
): Promise<LoopRunDetailDto> {
  const res = await apiFetch(
    `/api/loops/${encodeURIComponent(loopId)}/runs/${encodeURIComponent(runId)}`,
  );
  if (!res.ok) throw new Error(`Failed to load run (${res.status})`);
  return res.json();
}

/** Fleet stats for the Autopilot dashboard header (counters + 14-day sparkline). */
export interface LoopStatsDto {
  total: number;
  active: number;
  broken: number;
  successful7d: number;
  failed7d: number;
  successful24h: number;
  failed24h: number;
  sparkline: Array<{ day: string; ok: number; failed: number }>;
}

export async function fetchLoopStats(): Promise<LoopStatsDto> {
  const res = await apiFetch('/api/loops/stats');
  if (!res.ok) throw new Error('Failed to load loop stats');
  return res.json();
}

async function loopErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
}

export type WorktreePolicy = 'always' | 'never' | 'optional';
export type VerifyAutoSteer = 'on' | 'off' | 'inherit';

export interface ProjectConfigDto {
  path: string;
  name: string;
  defaultEngine: string | null;
  worktreePolicy: WorktreePolicy | null;
  verifyCommand: string | null;
  verifyAutoSteer: VerifyAutoSteer;
  verifyMaxRounds: number | null;
  mcpServerIds: string[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertProjectConfigInput {
  path: string;
  name?: string;
  defaultEngine?: string | null;
  worktreePolicy?: WorktreePolicy | null;
  verifyCommand?: string | null;
  verifyAutoSteer?: VerifyAutoSteer;
  verifyMaxRounds?: number | null;
  mcpServerIds?: string[] | null;
}

export async function fetchProjectConfigs(): Promise<ProjectConfigDto[]> {
  const res = await apiFetch('/api/projects/config');
  if (!res.ok) throw new Error('Failed to load project config');
  const data = (await res.json()) as { items?: ProjectConfigDto[] };
  return data.items ?? [];
}

export async function upsertProjectConfig(
  input: UpsertProjectConfigInput,
): Promise<ProjectConfigDto> {
  const res = await apiFetch('/api/projects/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await loopErrorMessage(res, 'Failed to save project config'));
  return res.json();
}

export async function deleteProjectConfig(path: string): Promise<void> {
  const res = await apiFetch(`/api/projects/config?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete project config');
}

// ── Forge repo browsing + clone (ProjectPicker forge sections) ──────────────
// Forge connection status reuses the existing `fetchForgeStatus` / `ForgeStatusDto`
// (forge-status-api.ts) — only repo listing + clone are new here.

/** A repo on a connected forge, pickable into a clone. */
export interface ForgeRepoDto {
  id: string;
  fullName: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  webUrl: string;
  updatedAt: number | null;
}

export async function fetchForgeRepos(forgeId: string, query = ''): Promise<ForgeRepoDto[]> {
  const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
  const res = await apiFetch(`/api/forges/${encodeURIComponent(forgeId)}/repos${params}`);
  if (!res.ok) throw new Error('Failed to load repositories');
  const data = (await res.json()) as { items?: ForgeRepoDto[] };
  return data.items ?? [];
}

/** Clone a forge repo locally; the returned path flows exactly like a picked local path. */
export async function cloneForgeRepo(input: {
  forgeId: string;
  fullName: string;
  cloneUrl: string;
  private: boolean;
}): Promise<{ path: string }> {
  const res = await apiFetch('/api/projects/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await loopErrorMessage(res, 'Failed to clone repository'));
  return res.json();
}
