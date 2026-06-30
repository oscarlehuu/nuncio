import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import { GitService } from '../../git/git.service';
import { SessionsService } from '../../sessions/sessions.service';
import type { ForgeWebhookEvent } from '../forges.types';

/** Issues carrying this label auto-create a session (D6 default: labeled issues only). */
const AUTO_CREATE_LABEL = 'nuncio';

export interface WebhookHandleResult {
  created: boolean;
  sessionId?: string;
  reason?: string;
}

/**
 * Maps a verified inbound webhook event onto a Nuncio session. Conservative by
 * default: only a freshly-opened issue labeled `nuncio`, on a repo that maps to
 * a locally-configured project, spawns a session. Deliveries are de-duplicated
 * so a webhook replay never creates a second session.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly sessions: SessionsService,
    private readonly git: GitService,
    private readonly db: DatabaseService,
  ) {}

  async handleEvent(provider: string, event: ForgeWebhookEvent): Promise<WebhookHandleResult> {
    if (event.action !== 'opened') return { created: false, reason: 'ignored-action' };
    if (event.kind !== 'issue') return { created: false, reason: 'ignored-kind' };
    if (!event.labels.includes(AUTO_CREATE_LABEL)) return { created: false, reason: 'no-label' };

    const projectPath = await this.findLocalProject(event.owner, event.repo);
    if (!projectPath) return { created: false, reason: 'unknown-repo' };

    // Without a delivery id we cannot de-duplicate replays safely — refuse rather
    // than collide every header-less delivery on a single ('provider','') row.
    if (!event.deliveryId) return { created: false, reason: 'missing-delivery-id' };
    if (!this.recordDelivery(provider, event.deliveryId)) {
      return { created: false, reason: 'duplicate' };
    }

    const prompt = `${event.title}\n\n${event.body}`.trim();
    const session = await this.sessions.create({
      prompt,
      projectPath,
      baseBranch: event.defaultBranch,
      useWorktree: true,
    });
    return { created: true, sessionId: session.id };
  }

  private async findLocalProject(owner: string, repo: string): Promise<string | null> {
    const projects = await this.git.listProjects();
    for (const project of projects) {
      try {
        const remote = await this.git.remoteInfo(project.path);
        if (remote.owner === owner && remote.repo === repo) return project.path;
      } catch {
        // Project without an `origin` remote — not a webhook target; skip.
      }
    }
    return null;
  }

  /** INSERT OR IGNORE; returns false when the delivery was already recorded (replay). */
  private recordDelivery(provider: string, deliveryId: string): boolean {
    const result = this.db.db
      .prepare(
        'INSERT OR IGNORE INTO forge_webhook_deliveries (provider, delivery_id, created_at) VALUES (?, ?, ?)',
      )
      .run(provider, deliveryId, Date.now());
    return result.changes > 0;
  }
}
