import { Injectable } from '@nestjs/common';
import { ForgeRepoService } from './forges-repo.service';
import { GitService } from '../git/git.service';
import { SessionsRepository } from '../sessions/persistence/sessions.repository';
import type { ForgePullRequestSummary } from './forges.types';

/** Short cache so the project view can poll without hammering the forge API. */
const PULL_REQUEST_TTL_MS = 30_000;

interface ProjectPullRequestCounts {
  /** Null only when the corresponding scope was not fetched (never zero-filled). */
  open: number | null;
  merged: number | null;
  closed: number | null;
}

interface ProjectPullRequestItemDto {
  number: number;
  title: string;
  /** Normalized state: `open` | `merged` | `closed`. */
  state: string;
  url: string;
  sourceBranch: string;
  author: string;
  /** The session that owns this pull request, when Nuncio knows it. */
  sessionId: string | null;
}

export interface ProjectPullRequestsDto {
  /** False when there is no forge remote or the forge is unauthenticated. */
  available: boolean;
  /** Forge provider id (`github`/`gitlab`) when resolvable, else null. */
  provider: string | null;
  /** `no-forge-remote` | `unavailable` when unavailable, else null. */
  reason: 'no-forge-remote' | 'unavailable' | null;
  counts: ProjectPullRequestCounts;
  /**
   * True when the forge paging cap was hit before all PRs were fetched — the
   * counts are then a floor, not an exact total. False in the normal case.
   */
  capped: boolean;
  pullRequests: ProjectPullRequestItemDto[];
}

/**
 * Bucket a forge's pull-request summaries by normalized state. Because the
 * caller always fetches the `all` scope, every bucket is a real count — honest,
 * never zero-filled for a scope that was skipped.
 */
export function bucketPullRequests(
  summaries: ForgePullRequestSummary[],
): { open: number; merged: number; closed: number } {
  let open = 0;
  let merged = 0;
  let closed = 0;
  for (const summary of summaries) {
    if (summary.state === 'open') open += 1;
    else if (summary.state === 'merged') merged += 1;
    else if (summary.state === 'closed') closed += 1;
  }
  return { open, merged, closed };
}

interface CacheEntry {
  expiresAt: number;
  value: ProjectPullRequestsDto;
}

/**
 * Devin-style per-project pull-request dashboard. Aggregates PR state for a
 * project with a forge remote via the existing forge provider layer, buckets
 * into open/merged/closed, and links each PR to the session/branch it came from
 * when known. Degrades gracefully — an unauthenticated forge is reported as
 * "unavailable", never surfaced as an auth prompt (ADR-005).
 */
@Injectable()
export class ProjectPullRequestsService {
  private readonly cache = new Map<string, CacheEntry>();
  private clock: () => number = Date.now;

  constructor(
    private readonly forgeRepo: ForgeRepoService,
    private readonly sessions: SessionsRepository,
    private readonly git: GitService,
  ) {}

  /** Test seam for the cache TTL clock. */
  setClock(clock: () => number): void {
    this.clock = clock;
  }

  async aggregate(path: string): Promise<ProjectPullRequestsDto> {
    const key = path.trim();
    const now = this.clock();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;

    const value = await this.compute(key);
    this.cache.set(key, { expiresAt: now + PULL_REQUEST_TTL_MS, value });
    return value;
  }

  private async compute(path: string): Promise<ProjectPullRequestsDto> {
    let provider: string | null = null;
    let connected = false;
    try {
      const caps = await this.forgeRepo.capabilities(path);
      provider = caps.provider;
      connected = caps.connected;
    } catch {
      // No origin remote / unsupported host / not a git repo.
      return this.unavailable('no-forge-remote', null);
    }

    if (!connected) return this.unavailable('unavailable', provider);

    let summaries: ForgePullRequestSummary[];
    let capped: boolean;
    try {
      // Page through EVERY PR before counting — a first-page-only fetch would
      // undercount a repo with more PRs than one page in a given state.
      const page = await this.forgeRepo.listPullRequestsPaged(path, 'all');
      summaries = page.pullRequests;
      capped = page.capped;
    } catch {
      return this.unavailable('unavailable', provider);
    }

    const counts = bucketPullRequests(summaries);
    const ownerByNumber = await this.resolvePullRequestOwners(path, summaries);
    const pullRequests = summaries.map((summary) => ({
      number: summary.number,
      title: summary.title,
      state: summary.state,
      url: summary.url,
      sourceBranch: summary.sourceBranch,
      author: summary.author,
      sessionId: ownerByNumber.get(summary.number) ?? null,
    }));

    return {
      available: true,
      provider,
      reason: null,
      counts,
      capped,
      pullRequests,
    };
  }

  /**
   * Map each PR number to its owning session id. An exact `project_path` match
   * is tried first (the common case, zero git). For the rest, the owner may be a
   * session opened in a LINKED WORKTREE of the same repo — its stored
   * `project_path` differs from the dashboard `path`, so raw-path matching misses
   * it. Fall back to comparing repo IDENTITY (worktree-aware), which collapses a
   * worktree onto its owning repo. Identity resolution is cached and only runs
   * for PR numbers left unresolved.
   */
  private async resolvePullRequestOwners(
    path: string,
    summaries: ForgePullRequestSummary[],
  ): Promise<Map<number, string>> {
    const ownerByNumber = new Map<number, string>();
    const unresolved: number[] = [];
    for (const summary of summaries) {
      const exact = this.sessions.findByProjectPullRequest(path, summary.number);
      if (exact) ownerByNumber.set(summary.number, exact.id);
      else unresolved.push(summary.number);
    }
    if (unresolved.length === 0) return ownerByNumber;

    const targetId = await this.resolveIdentityId(path);
    if (!targetId) return ownerByNumber;

    for (const number of unresolved) {
      const candidates = this.sessions.findAllByPullRequestNumber(number);
      for (const candidate of candidates) {
        if (!candidate.projectPath) continue;
        const candidateId = await this.resolveIdentityId(candidate.projectPath);
        if (candidateId && candidateId === targetId) {
          ownerByNumber.set(number, candidate.id);
          break;
        }
      }
    }
    return ownerByNumber;
  }

  /** Repo identity id for a path, or null when it is not a resolvable git repo. */
  private async resolveIdentityId(path: string): Promise<string | null> {
    try {
      const identity = await this.git.resolveRepoIdentity(path);
      return identity.kind === 'repo' ? identity.id : null;
    } catch {
      return null;
    }
  }

  private unavailable(
    reason: 'no-forge-remote' | 'unavailable',
    provider: string | null,
  ): ProjectPullRequestsDto {
    return {
      available: false,
      provider,
      reason,
      counts: { open: null, merged: null, closed: null },
      capped: false,
      pullRequests: [],
    };
  }
}
