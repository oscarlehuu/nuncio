import { Injectable, Optional, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { AttentionService } from '../../attention/attention.service';
import { DatabaseService } from '../../db/database.service';
import { GitService } from '../../git/git.service';
import { SchedulerService } from '../../scheduler/scheduler.service';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SessionsService } from '../../sessions/sessions.service';
import { SettingsService } from '../../settings/settings.service';
import { ForgeRepoService } from '../forges-repo.service';
import { ForgesService } from '../forges.service';
import type { ForgeWebhookEvent } from '../forges.types';
import { routeWebhookCiFailure } from './webhook-ci-failure-router';
import {
  WebhookDeliveryTracker,
  type WebhookDeliveryAcceptance,
  type WebhookDeliveryClaim,
} from './webhook-delivery-tracker';
import { routeWebhookFeedback } from './webhook-feedback-router';
import { findWebhookProject } from './webhook-project-resolver';
import { routePullRequestLifecycle } from './webhook-pr-lifecycle-router';
import { raiseWebhookSteerFailure, resolveWebhookSteerFailure } from './webhook-steer-failure';

const AUTO_CREATE_LABEL = 'nuncio';
const AUTO_STEER_SETTING = 'forges.autoSteer';
const AUTO_CLOSE_SETTING = 'forges.autoCloseOnMerge';
const DELIVERY_HEARTBEAT_MS = 20_000;

export interface WebhookHandleResult {
  created: boolean;
  steered?: boolean;
  closed?: boolean;
  archived?: boolean;
  sessionId?: string;
  reason?: string;
}

@Injectable()
export class WebhooksService implements OnModuleDestroy {
  private readonly stopFailureReporting: () => void;
  private readonly stopRecoveryReporting: () => void;
  private readonly deliveries: WebhookDeliveryTracker;

  constructor(
    private readonly sessions: SessionsService,
    private readonly git: GitService,
    private readonly db: DatabaseService,
    private readonly sessionRecords: SessionsRepository,
    private readonly settings: SettingsService,
    private readonly forges: ForgesService,
    private readonly forgeRepos: ForgeRepoService,
    private readonly attention: AttentionService,
    // Optional: event-triggered loops match issue/PR deliveries through the scheduler.
    @Optional() private readonly scheduler?: SchedulerService,
  ) {
    this.deliveries = new WebhookDeliveryTracker(this.db);
    this.stopFailureReporting = this.sessions.onBackgroundSteerFailure(
      ({ context, error }) => raiseWebhookSteerFailure(this.attention, context, error),
    );
    this.stopRecoveryReporting = this.sessions.onBackgroundSteerDelivered(
      ({ context }) => resolveWebhookSteerFailure(this.attention, context),
    );
  }

  onModuleDestroy(): void {
    this.stopFailureReporting();
    this.stopRecoveryReporting();
  }

  async handleEvent(provider: string, event: ForgeWebhookEvent): Promise<WebhookHandleResult> {
    // Event-triggered loops react to issue/PR deliveries independent of the narrow
    // auto-create / PR-lifecycle policies below, scoped to the delivery's project.
    await this.dispatchEventLoops(provider, event);
    if (event.kind === 'issue') return this.handleIssue(provider, event);
    if (event.kind === 'pull_request') return this.handlePullRequest(provider, event);
    if (event.kind !== 'pull_request_feedback' && event.kind !== 'ci_failure') {
      return { created: false, reason: 'ignored-kind' };
    }
    if (!this.settingEnabled(AUTO_STEER_SETTING)) {
      return { created: false, reason: 'auto-steer-disabled' };
    }
    if (!event.deliveryId) return { created: false, reason: 'missing-delivery-id' };
    return this.withDelivery(provider, event.deliveryId, async (accept) => {
      const projectPath = await findWebhookProject(
        this.git,
        event,
        (path) => this.sessionRecords.findByProjectPullRequest(path, event.number) !== null,
      );
      if (!projectPath) return accept(() => ({ created: false, reason: 'unknown-repo' }));
      if (event.kind === 'pull_request_feedback') {
        return routeWebhookFeedback(
          {
            sessions: this.sessions,
            sessionRecords: this.sessionRecords,
            forges: this.forges,
            attention: this.attention,
            accept,
          },
          provider,
          projectPath,
          event,
        );
      }
      return routeWebhookCiFailure(
        {
          sessions: this.sessions,
          sessionRecords: this.sessionRecords,
          forgeRepos: this.forgeRepos,
          attention: this.attention,
          accept,
        },
        provider,
        projectPath,
        event,
      );
    });
  }

  private async handleIssue(
    provider: string,
    event: Extract<ForgeWebhookEvent, { kind: 'issue' }>,
  ): Promise<WebhookHandleResult> {
    if (event.action !== 'opened') return { created: false, reason: 'ignored-action' };
    if (!event.labels.includes(AUTO_CREATE_LABEL)) return { created: false, reason: 'no-label' };
    if (!event.deliveryId) return { created: false, reason: 'missing-delivery-id' };
    return this.withDelivery(provider, event.deliveryId, async (accept, claim) => {
      const projectPath = await findWebhookProject(this.git, event);
      if (!projectPath) return accept(() => ({ created: false, reason: 'unknown-repo' }));
      const sessionId = this.deliveries.reserveSessionId(claim);
      const existing = this.sessionRecords.findById(sessionId);
      if (existing) return accept(() => ({ created: true, sessionId }));
      const session = await this.sessions.create({
        id: sessionId,
        prompt: `${event.title}\n\n${event.body}`.trim(),
        projectPath,
        baseBranch: event.defaultBranch,
        useWorktree: true,
      });
      return accept(() => ({ created: true, sessionId: session.id }));
    });
  }

  private async handlePullRequest(
    provider: string,
    event: Extract<ForgeWebhookEvent, { kind: 'pull_request' }>,
  ): Promise<WebhookHandleResult> {
    if (event.action !== 'closed') return { created: false, reason: 'ignored-action' };
    if (!event.deliveryId) return { created: false, reason: 'missing-delivery-id' };
    return this.withDelivery(provider, event.deliveryId, async (accept, claim) => {
      const projectPath = await findWebhookProject(
        this.git,
        event,
        (path) => {
          const owner = this.sessionRecords.findByProjectPullRequest(
            path,
            event.number,
            { includeArchived: true },
          );
          if (!owner) return false;
          return owner.status === 'ARCHIVED' ? 'archived' : 'live';
        },
      );
      if (!projectPath) return accept(() => ({ created: false, reason: 'unknown-repo' }));
      return routePullRequestLifecycle(
        {
          sessions: this.sessions,
          sessionRecords: this.sessionRecords,
          git: this.git,
          forgeRepos: this.forgeRepos,
          attention: this.attention,
          accept,
          deliveryRetrying: claim.retrying,
          cleanupCheckpoint: claim.checkpoint,
          markCleanupCheckpoint: () =>
            this.deliveries.markCheckpoint(claim, 'merge-cleanup-authorized'),
        },
        provider,
        projectPath,
        event,
        this.settingEnabled(AUTO_CLOSE_SETTING),
      );
    });
  }

  /**
   * Match a de-duplicated issue/PR delivery against event-triggered loops. Resolves
   * the delivery's local project and passes it to the scheduler so a loop scoped to
   * that project fires while a same-named event on another repo does not. Uses an
   * independent delivery-dedup keyspace (`#loops`) so a replay never double-fires a
   * loop and never collides with the auto-session / PR-lifecycle claim on the same id.
   */
  private async dispatchEventLoops(provider: string, event: ForgeWebhookEvent): Promise<void> {
    if (!this.scheduler) return;
    if (event.kind !== 'issue' && event.kind !== 'pull_request') return;
    if (!event.deliveryId) return;
    const claimed = this.deliveries.claim(provider, `${event.deliveryId}#loops`);
    if (claimed.status !== 'claimed') return; // completed (replay) or in-progress → skip
    try {
      const projectPath = await findWebhookProject(this.git, event);
      this.scheduler.handleWebhookEvent(provider, event, projectPath);
      this.deliveries.complete(claimed.claim, () => undefined);
    } catch {
      // A resolve/dispatch failure stays retryable — release the lease.
      this.deliveries.release(claimed.claim);
    }
  }

  private settingEnabled(key: string): boolean {
    const value = this.settings.resolve(key)?.trim().toLowerCase();
    return value === '1' || value === 'true';
  }

  private async withDelivery(
    provider: string,
    deliveryId: string,
    work: (
      accept: WebhookDeliveryAcceptance,
      claim: WebhookDeliveryClaim,
    ) => Promise<WebhookHandleResult>,
  ): Promise<WebhookHandleResult> {
    const claimed = this.deliveries.claim(provider, deliveryId);
    if (claimed.status === 'completed') return { created: false, reason: 'duplicate' };
    if (claimed.status === 'in-progress') {
      throw new ServiceUnavailableException('Webhook delivery is already being processed');
    }
    const claim = claimed.claim;
    const heartbeat = setInterval(() => {
      try {
        this.deliveries.renew(claim);
      } catch {
        // Completion verifies ownership; a transient renewal failure remains fail closed.
      }
    }, DELIVERY_HEARTBEAT_MS);
    heartbeat.unref?.();
    let completed = false;
    const accept: WebhookDeliveryAcceptance = <T>(durableWork: () => T): T => {
      const result = this.deliveries.complete(claim, durableWork);
      completed = true;
      return result;
    };
    try {
      const result = await work(accept, claim);
      return completed ? result : accept(() => result);
    } catch (error) {
      if (!completed) {
        try {
          this.deliveries.release(claim);
        } catch {
          // The lease expiry keeps a failed delivery retryable after DB recovery.
        }
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
