import { HttpException, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SettingsService } from '../../settings/settings.service';
import { githubCliToken } from '../cli-auth';
import { BaseForgeProvider } from '../forges.base-provider';
import { parseGithubWebhookEvent } from './github-webhook-parser';
import type {
  CreatePullRequestOptions,
  ForgeAuth,
  ForgeCheck,
  ForgePullRequest,
  ForgeRepoRef,
  ForgeUser,
  ForgeWebhookEvent,
} from '../forges.types';

interface GithubUserResponse {
  login: string;
  name?: string | null;
}

interface GithubCollaboratorPermissionResponse {
  permission?: string;
  role_name?: string;
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

interface GithubGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

/**
 * Auth, webhook, and basic-PR surface of the GitHub provider. The review /
 * merge / issue surface lives in GithubForgeProvider (github-forge.provider.ts).
 */
export abstract class GithubForgeCore extends BaseForgeProvider {
  readonly id = 'github';
  readonly name = 'GitHub';

  private cachedAuth?: ForgeAuth | null;

  constructor(protected readonly settings: SettingsService) {
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

  async canWriteRepository(repo: ForgeRepoRef, username: string): Promise<boolean> {
    const data = await this.request<GithubCollaboratorPermissionResponse>(
      `${this.repoUrl(repo)}/collaborators/${encodeURIComponent(username)}/permission`,
      { headers: await this.authHeaders() },
    );
    const permission = (data.permission ?? data.role_name ?? '').toLowerCase();
    return ['write', 'push', 'maintain', 'admin'].includes(permission);
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
    return parseGithubWebhookEvent(headers, payload, this.id);
  }

  bustCache(): void {
    this.cachedAuth = undefined;
  }

  protected async authHeaders(): Promise<HeadersInit> {
    const auth = await this.resolveAuth();
    if (!auth) {
      throw new UnauthorizedException('GitHub token is not configured');
    }
    return {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/vnd.github+json',
    };
  }

  protected repoUrl(repo: ForgeRepoRef): string {
    return `${this.resolveApiBase()}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  }

  protected mapPullRequest(data: GithubPullRequestResponse): ForgePullRequest {
    return {
      number: data.number,
      url: data.html_url,
      // GitHub reports a merged PR as state 'closed' + merged:true; surface 'merged'.
      state: data.merged ? 'merged' : data.state,
      title: data.title,
    };
  }

  protected resolveApiBase(): string {
    const configured = this.settings.resolve('GITHUB_API_URL')?.trim() || 'https://api.github.com';
    return configured.replace(/\/+$/, '');
  }

  /**
   * Minimal GraphQL client for the two thread operations REST cannot do
   * (reviewThreads with isResolved, resolve/unresolve). Everything else is REST.
   */
  protected async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const data = await this.request<GithubGraphqlResponse<T>>(this.resolveGraphqlUrl(), {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ query, variables }),
    });
    if (data.errors?.length) {
      throw new HttpException(
        `GitHub GraphQL failed: ${data.errors.map((e) => e.message ?? 'unknown').join('; ')}`,
        502,
      );
    }
    if (!data.data) {
      throw new HttpException('GitHub GraphQL returned no data', 502);
    }
    return data.data;
  }

  private resolveGraphqlUrl(): string {
    const base = this.resolveApiBase();
    // GHE REST base is <host>/api/v3; its GraphQL endpoint is <host>/api/graphql.
    if (base.endsWith('/api/v3')) return `${base.slice(0, -'/v3'.length)}/graphql`;
    return `${base}/graphql`;
  }
}
