import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { ForgeRepoService } from '../forges/forges-repo.service';
import { RecentProjectsRepository } from '../git/recent-projects.repository';
import { LoopsService } from '../loops/loops.service';
import { registerSessionEventHook } from '../sessions/domain/session-event-hooks';
import { SessionsRepository } from '../sessions/persistence/sessions.repository';
import { AttentionService } from './attention.service';
import type { AttentionItemDto } from './attention.types';

interface RequestPayload {
  requestId?: string;
  title?: string;
}

// Both interaction pairs share the same requestId keying + pending-input
// semantics (see derive-pending-input.ts). A session can block on a user-input
// question OR a provider (Codex) approval; the founder must clear either.
const REQUEST_EVENTS = new Set(['user_input_requested', 'provider_request']);
const RESOLVED_EVENTS = new Set(['user_input_resolved', 'provider_request_resolved']);

/**
 * Signal collectors that feed the attention queue.
 * ADDITIVE (ADR-007): every source is an EXISTING event or durable state — no
 * new session event types. Two ingestion styles:
 *
 *   - Event-driven (immediate): session interaction requests + verify-dead, via
 *     the `registerSessionEventHook` observer that already fires once per event.
 *   - Poll-based (on the heartbeat cadence, `sweep()`): broken loops + open PRs
 *     awaiting review, plus `reconcileOpenItems()` to auto-resolve cleared ones.
 *
 * Auto-resolve uses kind-probes (a broken loop that resumed) or a direct resolve
 * (a permission request that was answered).
 */
@Injectable()
export class AttentionCollectors implements OnModuleInit {
  private unsubscribe?: () => void;

  /**
   * Extra poll-collectors ride the same sweep cadence while keeping anomaly
   * heuristics decoupled from the core collectors.
   */
  private readonly extraSweeps = new Set<() => Promise<void>>();
  registerSweep(sweep: () => Promise<void>): () => void {
    this.extraSweeps.add(sweep);
    return () => this.extraSweeps.delete(sweep);
  }

  constructor(
    private readonly attention: AttentionService,
    @Optional() private readonly loops?: LoopsService,
    @Optional() private readonly sessions?: SessionsRepository,
    @Optional() private readonly forgeRepos?: ForgeRepoService,
    @Optional() private readonly recentProjects?: RecentProjectsRepository,
  ) {}

  onModuleInit(): void {
    // Event-driven collectors on the existing session-event observer seam.
    this.unsubscribe = registerSessionEventHook((sessionId, event) => {
      try {
        this.onSessionEvent(sessionId, event.type, event.payload);
      } catch {
        // A collector must never break the event-append path.
      }
    });

    // A broken loop that resumed / was deleted → its item auto-resolves.
    this.attention.registerProbe('tripped-breaker', (item) => this.loopStillBroken(item));
    // A verify-dead item clears only on an explicit re-run / resolve — no probe;
    // it stays until the founder acts (that is the whole point of "needs you").

    // Boot reconciliation re-derives open items against live state. A loop that
    // resumed while the daemon was down has its breaker item auto-resolved here.
    // Fire-and-forget at boot;
    // the forge leg must never crash startup.
    void this.sweep().catch(() => {});
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Route an appended session event to its collector. */
  private onSessionEvent(sessionId: string, type: string, payload: unknown): void {
    if (REQUEST_EVENTS.has(type)) {
      // user_input_requested OR provider_request (Codex/provider approval) — both
      // block the session on the founder and share the requestId keying.
      const p = (payload ?? {}) as RequestPayload;
      this.attention.raise({
        kind: 'permission',
        subjectId: `${sessionId}:${p.requestId ?? 'input'}`,
        projectPath: this.sessionProjectPath(sessionId),
        title: p.title || 'Session needs your input',
        payload: { sessionId, requestId: p.requestId ?? null },
      });
    } else if (RESOLVED_EVENTS.has(type)) {
      const p = (payload ?? {}) as RequestPayload;
      this.clearCondition('permission', `${sessionId}:${p.requestId ?? 'input'}`);
    } else if (type === 'verify_needs_attention') {
      this.attention.raise({
        kind: 'verify-dead',
        subjectId: sessionId,
        projectPath: this.sessionProjectPath(sessionId),
        title: 'Checks still failing after auto-fix — needs your decision',
        payload: { sessionId },
      });
    }
  }

  /**
   * Poll-based sweep — runs at boot and on the heartbeat fleet-reconciliation
   * cadence. Raises broken-loop + PR items and
   * auto-resolves the ones whose condition cleared, then reconciles remaining
   * open items via kind-probes. Async: the PR leg awaits the forge fetch.
   */
  async sweep(): Promise<void> {
    this.collectBrokenLoops();
    await this.collectPullRequests();
    // Registered extra collectors are best-effort so
    // one failing sweep never blocks the others or the reconcile.
    for (const extra of this.extraSweeps) {
      await extra().catch(() => {});
    }
    this.attention.reconcileOpenItems();
  }

  private collectBrokenLoops(): void {
    for (const loop of this.loops?.list() ?? []) {
      if (loop.status === 'broken') {
        this.attention.raise({
          kind: 'tripped-breaker',
          subjectId: loop.id,
          projectPath: loop.projectPath,
          title: `Autopilot paused "${loop.name ?? loop.goal}" after repeated failures`,
          payload: { loopId: loop.id },
        });
      } else {
        // The condition is CLEAR (loop resumed / completed) — drop any manual-
        // resolve suppression so a genuine re-trip later raises a fresh item, and
        // auto-resolve a still-open item.
        this.attention.onConditionCleared('tripped-breaker', loop.id);
      }
    }
  }

  /**
   * Fetch each remote repository once even when several local checkouts point to
   * it. Reconciliation is scoped to repositories fetched successfully so a
   * transient forge outage never clears review work we could not verify.
   */
  private async collectPullRequests(): Promise<void> {
    if (!this.forgeRepos || !this.recentProjects) return;

    const previouslyOpen = this.attention.list().items.filter((item) => item.kind === 'pr-review');
    const repoGroups = new Map<string, { projectPath: string; localPaths: string[] }>();
    for (const project of this.recentProjects.list()) {
      let repoIdentity: string;
      try {
        repoIdentity = normalizeRepoIdentity(
          await this.forgeRepos.resolveRepoIdentity(project.path),
        );
      } catch {
        continue;
      }
      const group = repoGroups.get(repoIdentity);
      if (group) {
        group.localPaths.push(project.path);
      } else {
        repoGroups.set(repoIdentity, { projectPath: project.path, localPaths: [project.path] });
      }
    }

    // A legacy item can outlive the recent-project cap. Resolve its still-local
    // path only as an alias of a recent repo; never let it create a fetch group.
    for (const item of previouslyOpen) {
      const path = item.projectPath;
      if (!path || legacyPullRequestNumber(item.subjectId, path) === null) continue;
      try {
        const repoIdentity = normalizeRepoIdentity(
          await this.forgeRepos.resolveRepoIdentity(path),
        );
        if (!payloadMatchesRepo(item.payload, repoIdentity)) continue;
        const group = repoGroups.get(repoIdentity);
        if (group && !group.localPaths.includes(path)) group.localPaths.push(path);
      } catch {
        // A removed checkout cannot be mapped safely, so preserve its row.
      }
    }

    for (const [repoIdentity, group] of repoGroups) {
      let openPrs: Array<{ number: number; title?: string; url: string }>;
      try {
        openPrs = await this.forgeRepos.listPullRequests(group.projectPath, 'open');
      } catch {
        // Without a trustworthy open set, preserve canonical and legacy rows.
        continue;
      }

      const stillOpen = new Set<string>();
      for (const pr of openPrs) {
        const subjectId = `${repoIdentity}#${pr.number}`;
        stillOpen.add(subjectId);
        this.attention.raise({
          kind: 'pr-review',
          subjectId,
          projectPath: group.projectPath,
          title: pr.title || `PR #${pr.number} awaiting review`,
          payload: {
            repo: repoIdentity,
            projectPath: group.projectPath,
            number: pr.number,
            url: pr.url,
          },
        });
      }

      const canonicalPrefix = `${repoIdentity}#`;
      const legacyPrefixes = group.localPaths.map((path) => `${path}#`);
      for (const item of previouslyOpen) {
        const isStaleCanonical = item.subjectId.startsWith(canonicalPrefix) && !stillOpen.has(item.subjectId);
        const isLegacy = legacyPrefixes.some((prefix) => {
          const path = prefix.slice(0, -1);
          return legacyPullRequestNumber(item.subjectId, path) !== null &&
            payloadMatchesRepo(item.payload, repoIdentity);
        });
        if (isStaleCanonical || isLegacy) {
          this.attention.onConditionCleared('pr-review', item.subjectId);
        }
      }
    }
  }

  /** Probe: is the loop behind a tripped-breaker item still broken? */
  private loopStillBroken(item: AttentionItemDto): boolean {
    const loop = this.loops?.findById(item.subjectId);
    return loop?.status === 'broken';
  }

  /** A condition observed clear (interaction answered / PR merged) → drop it. */
  private clearCondition(kind: string, subjectId: string): void {
    this.attention.onConditionCleared(kind, subjectId);
  }

  private sessionProjectPath(sessionId: string): string | null {
    return this.sessions?.findById(sessionId)?.projectPath ?? null;
  }
}

function normalizeRepoIdentity(identity: string): string {
  return identity.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

function legacyPullRequestNumber(subjectId: string, path: string): number | null {
  const prefix = `${path}#`;
  if (!subjectId.startsWith(prefix)) return null;
  const suffix = subjectId.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(suffix)) return null;
  const number = Number(suffix);
  return Number.isSafeInteger(number) ? number : null;
}

function payloadMatchesRepo(
  payload: Record<string, unknown> | null,
  repoIdentity: string,
): boolean {
  const storedRepo = payload?.repo;
  if (typeof storedRepo === 'string' && storedRepo.trim()) {
    const normalized = normalizeRepoIdentity(storedRepo).replace(/\.git$/i, '');
    if (normalized === repoIdentity) return true;
  }

  const url = payload?.url;
  return typeof url === 'string' && repoIdentityFromPullRequestUrl(url) === repoIdentity;
}

function repoIdentityFromPullRequestUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    const pullMarker = segments.findIndex((segment) => segment === 'pull');
    const gitlabMarker = segments.findIndex((segment) => segment === '-');
    const marker = pullMarker >= 0 ? pullMarker : gitlabMarker;
    if (marker < 2) return null;
    return normalizeRepoIdentity(`${url.hostname}/${segments.slice(0, marker).join('/')}`);
  } catch {
    return null;
  }
}
