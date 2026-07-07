import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { ForgeRepoService } from '../forges/forges-repo.service';
import { RecentProjectsRepository } from '../git/recent-projects.repository';
import { LoopsService } from '../loops/loops.service';
import { registerSessionEventHook } from '../sessions/domain/session-event-hooks';
import { SessionsRepository } from '../sessions/persistence/sessions.repository';
import { AttentionService } from './attention.service';
import type { AttentionItemDto } from './attention.types';

interface UserInputRequestedPayload {
  requestId?: string;
  title?: string;
}
interface UserInputResolvedPayload {
  requestId?: string;
}

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
    // has its tripped-breaker item auto-resolved here.
    this.sweep();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Route an appended session event to its collector. */
  private onSessionEvent(sessionId: string, type: string, payload: unknown): void {
    if (type === 'user_input_requested') {
      const p = (payload ?? {}) as UserInputRequestedPayload;
      this.attention.raise({
        kind: 'permission',
        subjectId: `${sessionId}:${p.requestId ?? 'input'}`,
        projectPath: this.sessionProjectPath(sessionId),
        title: p.title || 'Session needs your input',
        payload: { sessionId, requestId: p.requestId ?? null },
      });
    } else if (type === 'user_input_resolved') {
      const p = (payload ?? {}) as UserInputResolvedPayload;
      this.resolveOpen('permission', `${sessionId}:${p.requestId ?? 'input'}`);
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
   * cadence (sub-phase B wires the cadence). Raises broken-loop + PR items, then
   * reconciles open items against live state (auto-resolving the cleared ones).
   */
  sweep(): void {
    this.collectBrokenLoops();
    this.collectPullRequests();
    this.attention.reconcileOpenItems();
  }

  private collectBrokenLoops(): void {
    for (const loop of this.loops?.list() ?? []) {
      if (loop.status !== 'broken') continue;
      this.attention.raise({
        kind: 'tripped-breaker',
        subjectId: loop.id,
        projectPath: loop.projectPath,
        title: `Loop "${loop.name ?? loop.goal}" tripped its breaker`,
        payload: { loopId: loop.id },
      });
    }
  }

  private collectPullRequests(): void {
    if (!this.forgeRepos || !this.recentProjects) return;
    for (const project of this.recentProjects.list()) {
      // Best-effort per project: a disconnected forge / non-repo path is skipped,
      // never fatal to the sweep. Provider-neutral (GitHub + GitLab).
      void this.forgeRepos
        .listPullRequests(project.path, 'open')
        .then((prs) => {
          for (const pr of prs) {
            this.attention.raise({
              kind: 'pr-review',
              subjectId: `${project.path}#${pr.number}`,
              projectPath: project.path,
              title: pr.title || `PR #${pr.number} awaiting review`,
              payload: { projectPath: project.path, number: pr.number, url: pr.url },
            });
          }
        })
        .catch(() => {
          // Disconnected / unauthenticated forge → no PR items (never an error).
        });
    }
  }

  /** Probe: is the loop behind a tripped-breaker item still broken? */
  private loopStillBroken(item: AttentionItemDto): boolean {
    const loop = this.loops?.findById(item.subjectId);
    return loop?.status === 'broken';
  }

  private resolveOpen(kind: string, subjectId: string): void {
    const open = this.attention.list().items.find(
      (i) => i.kind === kind && i.subjectId === subjectId,
    );
    if (open) this.attention.resolve(open.id);
  }

  private sessionProjectPath(sessionId: string): string | null {
    return this.sessions?.findById(sessionId)?.projectPath ?? null;
  }
}
