import { Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { SettingsService } from '../../settings/settings.service';
import { gitlabCliToken } from '../cli-auth';
import { BaseForgeProvider } from '../forges.base-provider';
import type {
  CreatePullRequestOptions,
  ForgeAuth,
  ForgeCheck,
  ForgePullRequest,
  ForgeRepoRef,
  ForgeUser,
  ForgeWebhookEvent,
} from '../forges.types';

interface GitlabUserResponse {
  username: string;
  name?: string | null;
}

interface GitlabMergeRequestResponse {
  iid: number;
  web_url: string;
  state: string;
  title: string;
}

interface GitlabPipelineResponse {
  id: number;
  status: string;
}

interface GitlabWebhookAttributes {
  iid: number;
  title?: string;
  description?: string | null;
  action?: string;
  target_branch?: string;
}

interface GitlabWebhookPayload {
  object_attributes?: GitlabWebhookAttributes;
  project?: { path_with_namespace?: string; default_branch?: string };
  labels?: Array<{ title: string }>;
}

@Injectable()
export class GitlabForgeProvider extends BaseForgeProvider {
  readonly id = 'gitlab';
  readonly name = 'GitLab';

  private cachedAuth?: ForgeAuth | null;

  constructor(private readonly settings: SettingsService) {
    super();
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolveAuth()) !== null;
  }

  async resolveAuth(): Promise<ForgeAuth | null> {
    if (this.cachedAuth !== undefined) return this.cachedAuth;
    const token = this.settings.resolve('GITLAB_TOKEN')?.trim();
    if (token) {
      this.cachedAuth = { token, method: 'token' };
      return this.cachedAuth;
    }
    const cliToken = await (this.cliTokenOverride ?? gitlabCliToken)();
    this.cachedAuth = cliToken ? { token: cliToken, method: 'cli' } : null;
    return this.cachedAuth;
  }

  async getCurrentUser(): Promise<ForgeUser> {
    const data = await this.request<GitlabUserResponse>(`${this.resolveApiBase()}/user`, {
      headers: await this.authHeaders(),
    });
    return { login: data.username, name: data.name ?? null };
  }

  async createPullRequest(
    repo: ForgeRepoRef,
    opts: CreatePullRequestOptions,
  ): Promise<ForgePullRequest> {
    const data = await this.request<GitlabMergeRequestResponse>(
      `${this.projectUrl(repo)}/merge_requests`,
      {
        method: 'POST',
        headers: await this.authHeaders(),
        body: JSON.stringify({
          source_branch: opts.head,
          target_branch: opts.base,
          title: opts.title,
          description: opts.body,
        }),
      },
    );
    return this.mapMergeRequest(data);
  }

  async getPullRequest(repo: ForgeRepoRef, number: number): Promise<ForgePullRequest> {
    const data = await this.request<GitlabMergeRequestResponse>(
      `${this.projectUrl(repo)}/merge_requests/${number}`,
      { headers: await this.authHeaders() },
    );
    return this.mapMergeRequest(data);
  }

  async listChecks(repo: ForgeRepoRef, ref: string): Promise<ForgeCheck[]> {
    const data = await this.request<GitlabPipelineResponse[]>(
      `${this.projectUrl(repo)}/pipelines?ref=${encodeURIComponent(ref)}`,
      { headers: await this.authHeaders() },
    );
    return (data ?? []).map((pipeline) => ({
      name: `pipeline-${pipeline.id}`,
      status: pipeline.status,
      conclusion: pipeline.status,
    }));
  }

  async addComment(repo: ForgeRepoRef, number: number, body: string): Promise<void> {
    await this.request<unknown>(`${this.projectUrl(repo)}/merge_requests/${number}/notes`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ body }),
    });
  }

  verifyWebhookSignature(headers: Record<string, string | undefined>, _rawBody: string): boolean {
    const secret = this.settings.resolve('GITLAB_WEBHOOK_SECRET')?.trim();
    if (!secret) return false; // fail closed when unconfigured
    const provided = headers['x-gitlab-token'];
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseWebhookEvent(
    headers: Record<string, string | undefined>,
    payload: unknown,
  ): ForgeWebhookEvent | null {
    const eventType = headers['x-gitlab-event'];
    const kind =
      eventType === 'Issue Hook'
        ? ('issue' as const)
        : eventType === 'Merge Request Hook'
          ? ('pull_request' as const)
          : null;
    if (!kind) return null;

    const data = (payload ?? {}) as GitlabWebhookPayload;
    const attrs = data.object_attributes;
    const project = data.project;
    if (!attrs || !project?.path_with_namespace) return null;

    const fullName = project.path_with_namespace;
    const lastSlash = fullName.lastIndexOf('/');
    const owner = lastSlash >= 0 ? fullName.slice(0, lastSlash) : '';
    const repo = lastSlash >= 0 ? fullName.slice(lastSlash + 1) : fullName;

    return {
      provider: this.id,
      deliveryId: headers['x-gitlab-event-uuid'] ?? '',
      kind,
      action: this.normalizeAction(attrs.action),
      owner,
      repo,
      repoFullName: fullName,
      defaultBranch: project.default_branch ?? '',
      number: attrs.iid,
      title: attrs.title ?? '',
      body: attrs.description ?? '',
      labels: (data.labels ?? []).map((label) => label.title),
    };
  }

  /**
   * Normalize GitLab's action verbs (open/reopen/close/merge) to the common
   * ForgeWebhookEvent vocabulary (GitHub-style: opened/reopened/closed/merged)
   * that the provider-agnostic WebhooksService gates on.
   */
  private normalizeAction(action: string | undefined): string {
    switch (action) {
      case 'open':
        return 'opened';
      case 'reopen':
        return 'reopened';
      case 'close':
        return 'closed';
      case 'merge':
        return 'merged';
      default:
        return action ?? '';
    }
  }

  bustCache(): void {
    this.cachedAuth = undefined;
  }

  private async authHeaders(): Promise<HeadersInit> {
    const auth = await this.resolveAuth();
    if (!auth) {
      throw new UnauthorizedException('GitLab token is not configured');
    }
    return {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/json',
    };
  }

  private projectUrl(repo: ForgeRepoRef): string {
    const projectId = encodeURIComponent(`${repo.owner}/${repo.repo}`);
    return `${this.resolveApiBase()}/projects/${projectId}`;
  }

  private mapMergeRequest(data: GitlabMergeRequestResponse): ForgePullRequest {
    return {
      number: data.iid,
      url: data.web_url,
      state: data.state,
      title: data.title,
    };
  }

  private resolveApiBase(): string {
    const configured = this.settings.resolve('GITLAB_API_URL')?.trim() || 'https://gitlab.com/api/v4';
    return configured.replace(/\/+$/, '');
  }
}
