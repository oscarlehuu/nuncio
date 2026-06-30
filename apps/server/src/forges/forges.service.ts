import { BadRequestException, Injectable } from '@nestjs/common';
import { GitService } from '../git/git.service';
import { SessionsRepository } from '../sessions/persistence/sessions.repository';
import { ForgeRegistry } from './forges.registry';
import type { ForgeCheck, ForgePullRequest, ForgeRepoRef, ForgeStatusDto } from './forges.types';

export interface OpenPullRequestOptions {
  title?: string;
  body?: string;
  draft?: boolean;
  base?: string;
}

/**
 * Session-facing facade for the forge layer: maps a session's branch + origin
 * remote onto a forge provider and opens / refreshes a pull request. Provider
 * selection is host-based (github.com → github, *gitlab* → gitlab) so the
 * GitLab adapter (Phase 5) needs no change here.
 */
@Injectable()
export class ForgesService {
  constructor(
    private readonly registry: ForgeRegistry,
    private readonly git: GitService,
    private readonly sessions: SessionsRepository,
  ) {}

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

  async getPullRequestForSession(id: string): Promise<ForgePullRequest> {
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

    const pr = await provider.getPullRequest(repo, session.pullRequestNumber);
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
    return host.includes('gitlab') ? 'gitlab' : 'github';
  }
}
