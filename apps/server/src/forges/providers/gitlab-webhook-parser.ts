import type { ForgeWebhookEvent } from '../forges.types';

interface Attributes {
  id?: number;
  iid?: number;
  title?: string;
  description?: string | null;
  action?: string;
  status?: string;
  name?: string;
  note?: string | null;
  noteable_type?: string;
  url?: string;
  position?: { new_path?: string; old_path?: string; new_line?: number; old_line?: number };
}
interface Payload {
  object_attributes?: Attributes;
  project?: { path_with_namespace?: string; default_branch?: string };
  labels?: Array<{ title: string }>;
  user?: { username?: string };
  user_username?: string;
  merge_request?: { iid?: number; url?: string; web_url?: string };
}

export function parseGitlabWebhookEvent(
  headers: Record<string, string | undefined>,
  payload: unknown,
  provider: string,
): ForgeWebhookEvent | null {
  const data = (payload ?? {}) as Payload;
  const project = data.project;
  if (!project?.path_with_namespace) return null;
  const base = projectBase(provider, headers, project, data.labels);

  switch (headers['x-gitlab-event']) {
    case 'Issue Hook':
      return issueOrPullRequest(base, data, 'issue');
    case 'Merge Request Hook':
      return issueOrPullRequest(base, data, 'pull_request');
    case 'Note Hook':
      return noteEvent(base, data);
    case 'Pipeline Hook':
      return pipelineEvent(base, data);
    default:
      return null;
  }
}

function projectBase(
  provider: string,
  headers: Record<string, string | undefined>,
  project: NonNullable<Payload['project']>,
  labels: Payload['labels'],
) {
  const fullName = project.path_with_namespace!;
  const lastSlash = fullName.lastIndexOf('/');
  return {
    provider,
    deliveryId: headers['x-gitlab-event-uuid'] ?? '',
    owner: lastSlash >= 0 ? fullName.slice(0, lastSlash) : '',
    repo: lastSlash >= 0 ? fullName.slice(lastSlash + 1) : fullName,
    repoFullName: fullName,
    defaultBranch: project.default_branch ?? '',
    labels: (labels ?? []).map((label) => label.title),
  };
}

function issueOrPullRequest(
  base: ReturnType<typeof projectBase>,
  data: Payload,
  kind: 'issue' | 'pull_request',
): ForgeWebhookEvent | null {
  const attrs = data.object_attributes;
  if (!attrs || !Number.isInteger(attrs.iid)) return null;
  const rawAction = attrs.action;
  const action = normalizeAction(rawAction);
  const common = {
    ...base,
    kind,
    action,
    number: attrs.iid!,
    title: attrs.title ?? '',
    body: attrs.description ?? '',
  };
  if (kind === 'issue') return common;
  if (rawAction !== 'merge' && rawAction !== 'close') return common;
  return {
    ...common,
    merged: rawAction === 'merge',
    url: attrs.url ?? data.merge_request?.url ?? data.merge_request?.web_url ?? '',
  };
}

function noteEvent(
  base: ReturnType<typeof projectBase>,
  data: Payload,
): ForgeWebhookEvent | null {
  const attrs = data.object_attributes;
  const pull = data.merge_request;
  if (attrs?.noteable_type !== 'MergeRequest' || !Number.isInteger(pull?.iid)) return null;
  return {
    ...base,
    labels: [],
    kind: 'pull_request_feedback',
    action: attrs.action ?? 'created',
    number: pull!.iid!,
    author: data.user?.username ?? data.user_username ?? '',
    comments: [{
      body: attrs.note ?? '',
      ...(attrs.position?.new_path || attrs.position?.old_path
        ? { path: attrs.position.new_path ?? attrs.position.old_path! }
        : {}),
      ...(Number.isInteger(attrs.position?.new_line ?? attrs.position?.old_line)
        ? { line: (attrs.position?.new_line ?? attrs.position?.old_line)! }
        : {}),
    }],
    url: pull?.url ?? pull?.web_url ?? attrs.url ?? '',
  };
}

function pipelineEvent(
  base: ReturnType<typeof projectBase>,
  data: Payload,
): ForgeWebhookEvent | null {
  const attrs = data.object_attributes;
  const pull = data.merge_request;
  if (attrs?.status !== 'failed' || !Number.isInteger(attrs.id) || !Number.isInteger(pull?.iid)) {
    return null;
  }
  return {
    ...base,
    labels: [],
    kind: 'ci_failure',
    action: 'failed',
    number: pull!.iid!,
    runId: attrs.id!,
    jobName: attrs.name ?? `pipeline-${attrs.id}`,
    url: pull?.url ?? pull?.web_url ?? attrs.url ?? '',
  };
}

function normalizeAction(action: string | undefined): string {
  switch (action) {
    case 'open': return 'opened';
    case 'reopen': return 'reopened';
    case 'close':
    case 'merge': return 'closed';
    default: return action ?? '';
  }
}
