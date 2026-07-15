import type { ForgeReviewState, ForgeWebhookEvent } from '../forges.types';

type WebhookBase = Pick<ForgeWebhookEvent, 'provider' | 'deliveryId' | 'owner' | 'repo' | 'repoFullName' | 'defaultBranch' | 'labels'>;

interface Actor { login?: string }
interface Label { name: string }
interface IssueLike {
  number: number;
  title?: string;
  body?: string | null;
  labels?: Label[];
  html_url?: string;
  merged?: boolean;
  pull_request?: unknown;
}
interface Comment {
  body?: string | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  user?: Actor;
}
interface RunLike {
  id: number;
  name?: string;
  conclusion?: string | null;
  html_url?: string;
  pull_requests?: Array<{ number: number }>;
}
interface Payload {
  action?: string;
  issue?: IssueLike;
  pull_request?: IssueLike;
  review?: { state?: string; body?: string | null; user?: Actor };
  comment?: Comment;
  workflow_run?: RunLike;
  check_run?: RunLike;
  sender?: Actor;
  repository?: {
    name?: string;
    full_name?: string;
    default_branch?: string;
    owner?: Actor;
  };
}

export function parseGithubWebhookEvent(
  headers: Record<string, string | undefined>,
  payload: unknown,
  provider: string,
): ForgeWebhookEvent | null {
  const data = (payload ?? {}) as Payload;
  const repository = data.repository;
  if (!repository) return null;
  const base = {
    provider,
    deliveryId: headers['x-github-delivery'] ?? '',
    owner: repository.owner?.login ?? '',
    repo: repository.name ?? '',
    repoFullName: repository.full_name ?? '',
    defaultBranch: repository.default_branch ?? '',
    labels: [] as string[],
  };

  switch (headers['x-github-event']) {
    case 'issues':
      return data.issue ? issueEvent(base, data.action, data.issue, 'issue') : null;
    case 'pull_request':
      if (!data.pull_request) return null;
      return pullRequestEvent(base, data.action, data.pull_request);
    case 'pull_request_review':
      return reviewEvent(base, data);
    case 'pull_request_review_comment':
      return commentEvent(base, data, true);
    case 'issue_comment':
      return data.issue?.pull_request ? issueCommentEvent(base, data) : null;
    case 'workflow_run':
      return ciEvent(base, data.action, data.workflow_run, 'workflow');
    case 'check_run':
      return ciEvent(base, data.action, data.check_run, 'check');
    default:
      return null;
  }
}

function issueEvent(
  base: WebhookBase,
  action: string | undefined,
  issue: IssueLike,
  kind: 'issue',
): ForgeWebhookEvent {
  return { ...base, kind, action: action ?? '', ...issueFields(issue) };
}

function pullRequestEvent(
  base: WebhookBase,
  action: string | undefined,
  pull: IssueLike,
): ForgeWebhookEvent {
  const event: ForgeWebhookEvent = {
    ...base,
    kind: 'pull_request',
    action: action ?? '',
    ...issueFields(pull),
  };
  if (action !== 'closed') return event;
  return { ...event, merged: pull.merged === true, url: pull.html_url ?? '' };
}

function reviewEvent(base: WebhookBase, data: Payload): ForgeWebhookEvent | null {
  if (data.action !== 'submitted' || !data.pull_request || !data.review) return null;
  const state = normalizeReviewState(data.review.state);
  if (!state) return null;
  return feedback(base, data.action, data.pull_request, data.review.user ?? data.sender, [
    { body: data.review.body ?? '' },
  ], state);
}

function commentEvent(
  base: WebhookBase,
  data: Payload,
  withLocation: boolean,
): ForgeWebhookEvent | null {
  if (!['created', 'edited'].includes(data.action ?? '') || !data.pull_request || !data.comment) {
    return null;
  }
  const comment = {
    body: data.comment.body ?? '',
    ...(withLocation && data.comment.path ? { path: data.comment.path } : {}),
    ...(withLocation && Number.isInteger(data.comment.line ?? data.comment.original_line)
      ? { line: (data.comment.line ?? data.comment.original_line)! }
      : {}),
  };
  return feedback(
    base,
    data.action ?? '',
    data.pull_request,
    data.comment.user ?? data.sender,
    [comment],
  );
}

function issueCommentEvent(base: WebhookBase, data: Payload): ForgeWebhookEvent | null {
  if (!['created', 'edited'].includes(data.action ?? '') || !data.issue || !data.comment) return null;
  return feedback(base, data.action ?? '', data.issue, data.comment.user ?? data.sender, [
    { body: data.comment.body ?? '' },
  ]);
}

function feedback(
  base: WebhookBase,
  action: string,
  pull: IssueLike,
  actor: Actor | undefined,
  comments: Array<{ body: string; path?: string; line?: number }>,
  reviewState?: ForgeReviewState,
): ForgeWebhookEvent {
  return {
    ...base,
    kind: 'pull_request_feedback',
    action,
    number: pull.number,
    author: actor?.login ?? '',
    ...(reviewState ? { reviewState } : {}),
    comments,
    url: pull.html_url ?? '',
  };
}

function ciEvent(
  base: WebhookBase,
  action: string | undefined,
  run: RunLike | undefined,
  type: 'workflow' | 'check',
): ForgeWebhookEvent | null {
  const number = run?.pull_requests?.[0]?.number;
  if (action !== 'completed' || run?.conclusion !== 'failure' || !number) return null;
  return {
    ...base,
    kind: 'ci_failure',
    action: 'failed',
    number,
    ...(type === 'workflow' ? { runId: run.id } : { jobId: run.id }),
    jobName: run.name ?? (type === 'workflow' ? 'workflow' : 'check'),
    url: run.html_url ?? '',
  };
}

function issueFields(issue: IssueLike) {
  return {
    number: issue.number,
    title: issue.title ?? '',
    body: issue.body ?? '',
    labels: (issue.labels ?? []).map((label) => label.name),
  };
}

function normalizeReviewState(value: string | undefined): ForgeReviewState | null {
  const normalized = value?.toLowerCase();
  return normalized === 'approved' || normalized === 'changes_requested' || normalized === 'commented'
    ? normalized
    : null;
}
