import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GitService } from '../git/git.service';
import {
  PULL_REQUEST_ADOPTION_LEASE_MS,
  SessionsRepository,
} from '../sessions/persistence/sessions.repository';
import { SessionsService } from '../sessions/sessions.service';
import { ForgeRegistry, providerIdForHost } from './forges.registry';
import type {
  ForgeCheck,
  ForgePullRequest,
  ForgePullRequestDetail,
  ForgeRepoRef,
  ForgeRepository,
  ForgeStatusDto,
} from './forges.types';

export interface OpenPullRequestOptions {
  title?: string;
  body?: string;
  draft?: boolean;
  base?: string;
}

const AUTHOR_PERMISSION_TTL_MS = 60_000;
const PULL_REQUEST_ADOPTION_HEARTBEAT_MS = Math.floor(PULL_REQUEST_ADOPTION_LEASE_MS / 3);

/**
 * Session-facing facade for the forge layer: maps a session's branch + origin
 * remote onto a forge provider and opens / refreshes a pull request. Provider
 * selection is host-based (github.com → github, *gitlab* → gitlab) so the
 * GitLab adapter (Phase 5) needs no change here.
 */
@Injectable()
export class ForgesService {
  private readonly authorPermissionCache = new Map<
    string,
    { allowed: boolean; expiresAt: number }
  >();

  constructor(
    private readonly registry: ForgeRegistry,
    private readonly git: GitService,
    private readonly sessions: SessionsRepository,
    @Optional() private readonly sessionService?: SessionsService,
  ) {}

  async createSessionFromPullRequest(
    rawPath: string,
    number: number,
  ): Promise<{ sessionId: string }> {
    const path = rawPath?.trim();
    if (!path) throw new BadRequestException('path is required');
    if (!Number.isInteger(number) || number <= 0) {
      throw new BadRequestException('number must be a positive integer');
    }
    const projects = await this.git.listProjects();
    if (!projects.some((project) => project.path === path)) {
      throw new NotFoundException(`Project ${path} not found`);
    }
    if (!this.sessionService) throw new BadRequestException('Session creation is unavailable');

    const claimToken = randomUUID();
    const claim = this.sessions.claimPullRequestAdoption(path, number, claimToken);
    if (claim.status === 'existing') return { sessionId: claim.sessionId };
    if (claim.status === 'pending') {
      throw new ConflictException(`Pull request #${number} is already being adopted`);
    }

    let claimLost = false;
    const renewClaim = (): void => {
      if (claimLost || !this.sessions.renewPullRequestAdoption(path, number, claimToken)) {
        claimLost = true;
        throw new ConflictException(`Pull request #${number} adoption claim was lost`);
      }
    };
    const heartbeat = setInterval(() => {
      try {
        renewClaim();
      } catch {
        claimLost = true;
      }
    }, PULL_REQUEST_ADOPTION_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const remote = await this.git.remoteInfo(path);
      renewClaim();
      const provider = await this.registry.getAvailable(this.providerIdForHost(remote.host));
      renewClaim();
      const pullRequest = await provider.getPullRequestDetail(this.repoRef(remote), number);
      renewClaim();
      if (!pullRequest.sourceBranch?.trim()) {
        throw new BadRequestException(`Pull request #${number} has no source branch`);
      }
      if (pullRequest.sourceRepositoryMatchesTarget !== true) {
        throw new BadRequestException('Pull requests from fork repositories cannot be adopted safely');
      }
      if (provider.id !== 'github' && provider.id !== 'gitlab') {
        throw new BadRequestException(`Pull request worktrees are unsupported for ${provider.id}`);
      }
      const pullRequestHead = await this.git.fetchPullRequestHead(path, provider.id, number);
      renewClaim();
      const upstreamBranch = await this.git.fetchRemoteBranch(path, pullRequest.sourceBranch);
      renewClaim();
      const prompt = [
        `Continue pull request #${number}: ${pullRequest.title}`,
        '',
        pullRequest.body?.trim(),
        '',
        `Pull request: ${pullRequest.url}`,
      ]
        .filter((line) => line !== undefined)
        .join('\n')
        .trim();
      const session = await this.sessionService.create({
        prompt,
        projectPath: path,
        baseBranch: pullRequestHead,
        useWorktree: true,
        pushBranch: pullRequest.sourceBranch,
        upstreamBranch,
        forgeProvider: provider.id,
        pullRequestUrl: pullRequest.url,
        pullRequestNumber: pullRequest.number,
        pullRequestState: pullRequest.state,
        forgeStatus: pullRequest.state,
      });
      renewClaim();
      this.sessions.completePullRequestAdoption(path, number, claimToken, session.id, {
        forgeProvider: provider.id,
        pullRequestUrl: pullRequest.url,
        pullRequestState: pullRequest.state,
        forgeStatus: pullRequest.state,
      });
      return { sessionId: session.id };
    } catch (error) {
      this.sessions.releasePullRequestAdoption(path, number, claimToken);
      const owner = this.sessions.findByProjectPullRequest(path, number);
      if (owner) return { sessionId: owner.id };
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async openPullRequestForSession(
    id: string,
    opts: OpenPullRequestOptions = {},
  ): Promise<ForgePullRequest> {
    const session = this.sessions.findById(id);
    if (!session) throw new BadRequestException(`Session ${id} not found`);
    if (!session.branch) {
      throw new BadRequestException('Session has no branch to open a pull request from');
    }
    const repoPath = session.worktreePath ?? session.projectPath;
    if (!repoPath) {
      throw new BadRequestException('Session has no git working directory');
    }

    const remote = await this.git.remoteInfo(repoPath);
    const provider = await this.registry.getAvailable(this.providerIdForHost(remote.host));

    const pr = await provider.createPullRequest(this.repoRef(remote), {
      title: opts.title ?? session.title,
      body: opts.body ?? session.prompt,
      head: session.branch,
      base: opts.base ?? session.baseBranch ?? 'main',
      draft: opts.draft,
    });

    this.sessions.updateForgeState(id, {
      forgeProvider: provider.id,
      pullRequestUrl: pr.url,
      pullRequestNumber: pr.number,
      pullRequestState: pr.state,
      forgeStatus: 'open',
    });

    return pr;
  }

  async getPullRequestForSession(
    id: string,
  ): Promise<ForgePullRequestDetail & { checks: ForgeCheck[] }> {
    const session = this.sessions.findById(id);
    if (!session) throw new BadRequestException(`Session ${id} not found`);
    if (session.pullRequestNumber == null) {
      throw new BadRequestException('Session has no pull request');
    }
    const repoPath = session.worktreePath ?? session.projectPath;
    if (!repoPath) {
      throw new BadRequestException('Session has no git working directory');
    }

    const remote = await this.git.remoteInfo(repoPath);
    const repo = this.repoRef(remote);
    const provider = await this.registry.getAvailable(
      session.forgeProvider ?? this.providerIdForHost(remote.host),
    );

    const pr = await provider.getPullRequestDetail(repo, session.pullRequestNumber);
    const checks: ForgeCheck[] = session.branch
      ? await provider.listChecks(repo, session.branch)
      : [];

    this.sessions.updateForgeState(id, { pullRequestState: pr.state, forgeStatus: pr.state });

    return { ...pr, checks };
  }

  async addCommentForSession(id: string, body: string): Promise<void> {
    const session = this.sessions.findById(id);
    if (!session) throw new BadRequestException(`Session ${id} not found`);
    if (session.pullRequestNumber == null) {
      throw new BadRequestException('Session has no pull request');
    }
    const repoPath = session.worktreePath ?? session.projectPath;
    if (!repoPath) {
      throw new BadRequestException('Session has no git working directory');
    }

    const remote = await this.git.remoteInfo(repoPath);
    const provider = await this.registry.getAvailable(
      session.forgeProvider ?? this.providerIdForHost(remote.host),
    );
    await provider.addComment(this.repoRef(remote), session.pullRequestNumber, body);
  }

  /**
   * Enumerate the authenticated user's repositories for the forge-aware picker.
   * `getAvailable` throws a 4xx for an unknown OR unauthenticated forge — the UI
   * renders that reason as disabled, never an auth prompt (ADR-005). A provider
   * that cannot enumerate repos (capability off) is also a 4xx, not an empty list.
   */
  async listRepositories(id: string): Promise<ForgeRepository[]> {
    const provider = await this.registry.getAvailable(id);
    if (!provider.capabilities().listRepositories) {
      throw new BadRequestException(`Forge provider ${id} cannot list repositories`);
    }
    return provider.listRepositories();
  }

  async listStatus(): Promise<ForgeStatusDto[]> {
    const providers = this.registry.all();
    return Promise.all(
      providers.map(async (provider) => {
        const auth = await this.withTimeout(provider.resolveAuth(), 2500, null).catch(() => null);
        const connected = auth !== null;
        let login: string | null = null;
        if (connected) {
          try {
            const user = await this.withTimeout(provider.getCurrentUser(), 2500, null);
            if (user && 'login' in user) {
              login = user.login;
            }
          } catch {
            // Ignore error, return login as null.
          }
        }
        return {
          id: provider.id,
          name: provider.name,
          connected,
          method: auth?.method ?? null,
          login,
        };
      }),
    );
  }

  async canAuthorWriteRepository(
    providerId: string,
    repo: ForgeRepoRef,
    author: string,
  ): Promise<boolean> {
    const key = `${providerId}:${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}:${author.toLowerCase()}`;
    const cached = this.authorPermissionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.allowed;

    let allowed = false;
    try {
      const provider = await this.registry.getAvailable(providerId);
      allowed = await provider.canWriteRepository(repo, author);
    } catch {
      // A missing or failed authorization proof must never reach the steer sink.
    }
    this.authorPermissionCache.set(key, {
      allowed,
      expiresAt: Date.now() + AUTHOR_PERMISSION_TTL_MS,
    });
    return allowed;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
    ]);
  }

  private repoRef(remote: { owner: string; repo: string }): ForgeRepoRef {
    return { owner: remote.owner, repo: remote.repo };
  }

  private providerIdForHost(host: string): string {
    return providerIdForHost(host);
  }
}
