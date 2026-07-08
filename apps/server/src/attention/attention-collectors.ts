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
 * The rung-1/2 signal collectors that feed the attention queue (sub-phase A).
 * ADDITIVE (ADR-007): every source is an EXISTING event or durable state — no
 * new session event types. Two ingestion styles:
 *
 *   - Event-driven (immediate): session interaction requests + verify-dead, via
 *     the `registerSessionEventHook` observer that already fires once per event.
 *   - Poll-based (on the heartbeat cadence, `sweep()`): broken loops + open PRs
 *     awaiting review, plus `reconcileOpenItems()` to auto-resolve cleared ones.
 *
 * Auto-resolve uses kind-probes (a broken loop that resumed) or a direct resolve
 * (a permission request that was answered), per decision #2.
 */
@Injectable()
export class AttentionCollectors implements OnModuleInit {
  private unsubscribe?: () => void;

  /**
   * Extra poll-collectors that ride the same sweep cadence (rung-3 sub-phase C
   * anomaly heuristics register here) — keeps A's core decoupled from C while the
   * anomalies still run every sweep with their own raise+clear paths.
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

    // Boot reconciliation: re-derive open items against live state (persist +
    // reconcile — decision #3). A loop that resumed while the daemon was down
    // has its tripped-breaker item auto-resolved here. Fire-and-forget at boot;
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
        title: 'Verify failed after auto-fix rounds',
        payload: { sessionId },
      });
    }
  }

  /**
   * Poll-based sweep — runs at boot and on the heartbeat fleet-reconciliation
   * cadence (sub-phase B wires the cadence). Raises broken-loop + PR items and
   * auto-resolves the ones whose condition cleared, then reconciles remaining
   * open items via kind-probes. Async: the PR leg awaits the forge fetch.
   */
  async sweep(): Promise<void> {
    this.collectBrokenLoops();
    await this.collectPullRequests();
    // Registered extra collectors (sub-phase C anomalies) — each is best-effort so
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
          title: `Loop "${loop.name ?? loop.goal}" tripped its breaker`,
          payload: { loopId: loop.id },
        });
      } else {
        // The condition is CLEAR (loop resumed / completed) — drop any manual-
        // resolve suppression so a genuine re-trip later raises a fresh item, and
        // auto-resolve a still-open item (finding #2).
        this.attention.onConditionCleared('tripped-breaker', loop.id);
      }
    }
  }

  /**
   * Per project: fetch the open PRs and raise an item for each. Then diff the
   * previously-tracked open PR item keys against the freshly-fetched open set and
   * auto-resolve the missing ones — a merged/closed PR clears its item (finding
   * #3). CRITICAL: on a forge fetch failure the project is SKIPPED entirely (no
   * mass-resolve), so a transient outage never wipes real review items.
   */
  private async collectPullRequests(): Promise<void> {
    if (!this.forgeRepos || !this.recentProjects) return;
    for (const project of this.recentProjects.list()) {
      let openPrs: Array<{ number: number; title?: string; url: string }>;
      try {
        openPrs = await this.forgeRepos.listPullRequests(project.path, 'open');
      } catch {
        // Disconnected / unauthenticated / unreachable forge → leave this
        // project's PR items untouched (conservative; never mass-resolve).
        continue;
      }

      const stillOpen = new Set<string>();
      for (const pr of openPrs) {
        const subjectId = `${project.path}#${pr.number}`;
        stillOpen.add(subjectId);
        this.attention.raise({
          kind: 'pr-review',
          subjectId,
          projectPath: project.path,
          title: pr.title || `PR #${pr.number} awaiting review`,
          payload: { projectPath: project.path, number: pr.number, url: pr.url },
        });
      }

      // Any pr-review item for THIS project no longer in the open set has
      // merged/closed — clear it.
      for (const item of this.attention.list().items) {
        if (item.kind !== 'pr-review') continue;
        if (item.projectPath !== project.path) continue;
        if (stillOpen.has(item.subjectId)) continue;
        this.attention.onConditionCleared('pr-review', item.subjectId);
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
