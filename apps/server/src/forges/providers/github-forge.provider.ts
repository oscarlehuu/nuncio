import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SettingsService } from '../../settings/settings.service';
import { githubCliToken } from '../cli-auth';
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

interface GithubWebhookActor {
  login?: string;
}

interface GithubWebhookIssue {
  number: number;
  title?: string;
  body?: string | null;
  labels?: Array<{ name: string }>;
}

interface GithubWebhookPayload {
  action?: string;
  issue?: GithubWebhookIssue;
  pull_request?: GithubWebhookIssue;
  repository?: {
    name?: string;
    full_name?: string;
    default_branch?: string;
    owner?: GithubWebhookActor;
  };
}

interface GithubUserResponse {
  login: string;
  name?: string | null;
}

interface GithubPullRequestResponse {
  number: number;
  html_url: string;
  state: string;
  title: string;
  merged?: boolean;
}

interface GithubCheckRunResponse {
  name: string;
  status: string;
  conclusion: string | null;
}

interface GithubCheckRunsResponse {
  check_runs?: GithubCheckRunResponse[];
}

@Injectable()
export class GithubForgeProvider extends BaseForgeProvider {
  readonly id = 'github';
  readonly name = 'GitHub';

  private cachedAuth?: ForgeAuth | null;

  constructor(private readonly settings: SettingsService) {
    super();
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolveAuth()) !== null;
  }

  async resolveAuth(): Promise<ForgeAuth | null> {
    if (this.cachedAuth !== undefined) return this.cachedAuth;
    const token = this.settings.resolve('GITHUB_TOKEN')?.trim();
    if (token) {
      this.cachedAuth = { token, method: 'token' };
      return this.cachedAuth;
    }
    const cliToken = await (this.cliTokenOverride ?? githubCliToken)();
    this.cachedAuth = cliToken ? { token: cliToken, method: 'cli' } : null;
    return this.cachedAuth;
  }

  async getCurrentUser(): Promise<ForgeUser> {
    const data = await this.request<GithubUserResponse>(`${this.resolveApiBase()}/user`, {
      headers: await this.authHeaders(),
    });
    return { login: data.login, name: data.name ?? null };
  }

  async createPullRequest(
    repo: ForgeRepoRef,
    opts: CreatePullRequestOptions,
  ): Promise<ForgePullRequest> {
    const data = await this.request<GithubPullRequestResponse>(`${this.repoUrl(repo)}/pulls`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
        draft: opts.draft,
      }),
    });
    return this.mapPullRequest(data);
  }

  async getPullRequest(repo: ForgeRepoRef, number: number): Promise<ForgePullRequest> {
    const data = await this.request<GithubPullRequestResponse>(`${this.repoUrl(repo)}/pulls/${number}`, {
      headers: await this.authHeaders(),
    });
    return this.mapPullRequest(data);
  }

  async listChecks(repo: ForgeRepoRef, ref: string): Promise<ForgeCheck[]> {
    const data = await this.request<GithubCheckRunsResponse>(
      `${this.repoUrl(repo)}/commits/${encodeURIComponent(ref)}/check-runs`,
      { headers: await this.authHeaders() },
    );
    return (data.check_runs ?? []).map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion ?? null,
    }));
  }

  async addComment(repo: ForgeRepoRef, number: number, body: string): Promise<void> {
    await this.request<unknown>(`${this.repoUrl(repo)}/issues/${number}/comments`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ body }),
    });
  }

  verifyWebhookSignature(headers: Record<string, string | undefined>, rawBody: string): boolean {
    const secret = this.settings.resolve('GITHUB_WEBHOOK_SECRET')?.trim();
    if (!secret) return false; // fail closed when unconfigured
    const provided = headers['x-hub-signature-256'];
    if (!provided) return false;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseWebhookEvent(
    headers: Record<string, string | undefined>,
    payload: unknown,
  ): ForgeWebhookEvent | null {
    const eventType = headers['x-github-event'];
    const data = (payload ?? {}) as GithubWebhookPayload;
    const repository = data.repository;
    if (!repository) return null;

    const base = {
      provider: this.id,
      deliveryId: headers['x-github-delivery'] ?? '',
      action: data.action ?? '',
      owner: repository.owner?.login ?? '',
      repo: repository.name ?? '',
      repoFullName: repository.full_name ?? '',
      defaultBranch: repository.default_branch ?? '',
    };

    if (eventType === 'issues' && data.issue) {
      return { ...base, kind: 'issue', ...this.mapIssueFields(data.issue) };
    }
    if (eventType === 'pull_request' && data.pull_request) {
      return { ...base, kind: 'pull_request', ...this.mapIssueFields(data.pull_request) };
    }
    return null;
  }

  private mapIssueFields(issue: GithubWebhookIssue) {
    return {
      number: issue.number,
      title: issue.title ?? '',
      body: issue.body ?? '',
      labels: (issue.labels ?? []).map((label) => label.name),
    };
  }

  bustCache(): void {
    this.cachedAuth = undefined;
  }

  private async authHeaders(): Promise<HeadersInit> {
    const auth = await this.resolveAuth();
    if (!auth) {
      throw new UnauthorizedException('GitHub token is not configured');
    }
    return {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/vnd.github+json',
    };
  }

  private repoUrl(repo: ForgeRepoRef): string {
    return `${this.resolveApiBase()}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  }

  private mapPullRequest(data: GithubPullRequestResponse): ForgePullRequest {
    return {
      number: data.number,
      url: data.html_url,
      // GitHub reports a merged PR as state 'closed' + merged:true; surface 'merged'.
      state: data.merged ? 'merged' : data.state,
      title: data.title,
    };
  }

  private resolveApiBase(): string {
    const configured = this.settings.resolve('GITHUB_API_URL')?.trim() || 'https://api.github.com';
    return configured.replace(/\/+$/, '');
  }
}
