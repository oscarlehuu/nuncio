import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AttentionService } from '../../attention/attention.service';
import { DatabaseService } from '../../db/database.service';
import { GitService } from '../../git/git.service';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SessionsService } from '../../sessions/sessions.service';
import { SettingsService } from '../../settings/settings.service';
import { ForgeRepoService } from '../forges-repo.service';
import { ForgesService } from '../forges.service';
import type { ForgeWebhookEvent } from '../forges.types';
import { routeWebhookCiFailure } from './webhook-ci-failure-router';
import { routeWebhookFeedback } from './webhook-feedback-router';
import { findWebhookProject } from './webhook-project-resolver';
import { routePullRequestLifecycle } from './webhook-pr-lifecycle-router';
import { raiseWebhookSteerFailure } from './webhook-steer-failure';

const AUTO_CREATE_LABEL = 'nuncio';
const AUTO_STEER_SETTING = 'forges.autoSteer';
const AUTO_CLOSE_SETTING = 'forges.autoCloseOnMerge';

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

  constructor(
    private readonly sessions: SessionsService,
    private readonly git: GitService,
    private readonly db: DatabaseService,
    private readonly sessionRecords: SessionsRepository,
    private readonly settings: SettingsService,
    private readonly forges: ForgesService,
    private readonly forgeRepos: ForgeRepoService,
    private readonly attention: AttentionService,
  ) {
    this.stopFailureReporting = this.sessions.onBackgroundSteerFailure(
      ({ context, error }) => raiseWebhookSteerFailure(this.attention, context, error),
    );
  }

  onModuleDestroy(): void {
    this.stopFailureReporting();
  }

  async handleEvent(provider: string, event: ForgeWebhookEvent): Promise<WebhookHandleResult> {
    if (event.kind === 'issue') return this.handleIssue(provider, event);
    if (event.kind === 'pull_request') return this.handlePullRequest(provider, event);
    if (event.kind !== 'pull_request_feedback' && event.kind !== 'ci_failure') {
      return { created: false, reason: 'ignored-kind' };
    }
    if (!this.settingEnabled(AUTO_STEER_SETTING)) {
      return { created: false, reason: 'auto-steer-disabled' };
    }
    if (!event.deliveryId) return { created: false, reason: 'missing-delivery-id' };
    if (!this.recordDelivery(provider, event.deliveryId)) {
      return { created: false, reason: 'duplicate' };
    }

    const projectPath = await findWebhookProject(
      this.git,
      event,
      (path) => this.sessionRecords.findByProjectPullRequest(path, event.number) !== null,
    );
    if (!projectPath) return { created: false, reason: 'unknown-repo' };
    if (event.kind === 'pull_request_feedback') {
      return routeWebhookFeedback(
        {
          sessions: this.sessions,
          sessionRecords: this.sessionRecords,
          forges: this.forges,
          attention: this.attention,
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
      },
      provider,
      projectPath,
      event,
    );
  }

  private async handleIssue(
    provider: string,
    event: Extract<ForgeWebhookEvent, { kind: 'issue' }>,
  ): Promise<WebhookHandleResult> {
    if (event.action !== 'opened') return { created: false, reason: 'ignored-action' };
    if (!event.labels.includes(AUTO_CREATE_LABEL)) return { created: false, reason: 'no-label' };
    const projectPath = await findWebhookProject(this.git, event);
    if (!projectPath) return { created: false, reason: 'unknown-repo' };
    if (!event.deliveryId) return { created: false, reason: 'missing-delivery-id' };
    if (!this.recordDelivery(provider, event.deliveryId)) {
      return { created: false, reason: 'duplicate' };
    }
    const session = await this.sessions.create({
      prompt: `${event.title}\n\n${event.body}`.trim(),
      projectPath,
      baseBranch: event.defaultBranch,
      useWorktree: true,
    });
    return { created: true, sessionId: session.id };
  }

  private async handlePullRequest(
    provider: string,
    event: Extract<ForgeWebhookEvent, { kind: 'pull_request' }>,
  ): Promise<WebhookHandleResult> {
    if (event.action !== 'closed') return { created: false, reason: 'ignored-action' };
    if (!event.deliveryId) return { created: false, reason: 'missing-delivery-id' };
    if (!this.recordDelivery(provider, event.deliveryId)) {
      return { created: false, reason: 'duplicate' };
    }
    const projectPath = await findWebhookProject(
      this.git,
      event,
      (path) => this.sessionRecords.findByProjectPullRequest(
        path,
        event.number,
        { includeArchived: true },
      ) !== null,
    );
    if (!projectPath) return { created: false, reason: 'unknown-repo' };
    return routePullRequestLifecycle(
      {
        sessions: this.sessions,
        sessionRecords: this.sessionRecords,
        git: this.git,
        attention: this.attention,
      },
      provider,
      projectPath,
      event,
      this.settingEnabled(AUTO_CLOSE_SETTING),
    );
  }

  private settingEnabled(key: string): boolean {
    const value = this.settings.resolve(key)?.trim().toLowerCase();
    return value === '1' || value === 'true';
  }

  private recordDelivery(provider: string, deliveryId: string): boolean {
    const result = this.db.db
      .prepare(
        'INSERT OR IGNORE INTO forge_webhook_deliveries (provider, delivery_id, created_at) VALUES (?, ?, ?)',
      )
      .run(provider, deliveryId, Date.now());
    return result.changes > 0;
  }
}
