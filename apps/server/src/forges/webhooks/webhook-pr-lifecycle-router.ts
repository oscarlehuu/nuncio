import type { AttentionService } from '../../attention/attention.service';
import type { GitService } from '../../git/git.service';
import type { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import type { SessionsService } from '../../sessions/sessions.service';
import type { ForgePullRequestWebhookEvent } from '../forges.types';
import type { WebhookDeliveryAcceptance } from './webhook-delivery-tracker';

interface LifecycleDependencies {
  sessions: SessionsService;
  sessionRecords: SessionsRepository;
  git: GitService;
  attention: AttentionService;
  accept: WebhookDeliveryAcceptance;
  deliveryRetrying: boolean;
  cleanupCheckpoint: string | null;
  assertDeliveryOwnership: () => void;
  markCleanupCheckpoint: () => void;
}

export async function routePullRequestLifecycle(
  deps: LifecycleDependencies,
  provider: string,
  projectPath: string,
  event: ForgePullRequestWebhookEvent,
  autoCloseOnMerge: boolean,
) {
  const session = deps.sessionRecords.findByProjectPullRequest(
    projectPath,
    event.number,
    { includeArchived: true },
  );
  if (!session) {
    return deps.accept(() => {
      deps.attention.raise({
        kind: 'pr-feedback',
        subjectId: `${event.repoFullName}#${event.number}`,
        projectPath,
        title: `PR #${event.number} closed without an owning session`,
        payload: { provider, number: event.number, merged: event.merged === true, url: event.url ?? '' },
      });
      return { created: false, reason: 'no-owning-session' } as const;
    });
  }

  const state = event.merged === true ? 'merged' : 'closed';
  const acceptTerminal: WebhookDeliveryAcceptance = (work) => deps.accept(() => {
    deps.sessionRecords.updateForgeState(session.id, {
      forgeProvider: provider,
      pullRequestUrl: event.url,
      pullRequestNumber: event.number,
      pullRequestState: state,
      forgeStatus: state,
    });
    clearPullRequestAttention(deps.attention, projectPath, event);
    return work();
  });

  if (!event.merged) {
    return acceptTerminal(() => (
      { created: false, closed: true, sessionId: session.id } as const
    ));
  }
  if (!autoCloseOnMerge) {
    return acceptTerminal(() => ({
      created: false,
      closed: true,
      sessionId: session.id,
      reason: 'auto-close-disabled',
    } as const));
  }
  if (session.status === 'ARCHIVED') {
    if (
      deps.cleanupCheckpoint === 'merge-cleanup-authorized' &&
      session.projectPath &&
      session.worktreePath
    ) {
      if (deps.sessionRecords.findActiveSuccessor(session.id, session.worktreePath)) {
        return acceptTerminal(() =>
          skipCleanup(deps.attention, projectPath, event, 'worktree-handed-off'));
      }
      deps.assertDeliveryOwnership();
      const removal = await deps.git.removeWorktreeIfSafe(
        session.projectPath,
        session.worktreePath,
        { fallbackBase: session.baseBranch },
      );
      if (!removal.removed && removal.reason !== 'worktree-missing') {
        return acceptTerminal(() => skipCleanup(
          deps.attention,
          projectPath,
          event,
          removal.reason ?? 'worktree-removal-failed',
        ));
      }
      return acceptTerminal(() => {
        deps.sessionRecords.clearWorktreeMetadata(session.id);
        return {
          created: false,
          closed: true,
          sessionId: session.id,
          reason: 'already-archived',
        } as const;
      });
    }
    if (deps.deliveryRetrying && session.worktreePath) {
      return acceptTerminal(() => skipCleanup(
        deps.attention,
        projectPath,
        event,
        'cleanup-authorization-missing',
      ));
    }
    return acceptTerminal(() => ({
        created: false,
        closed: true,
        sessionId: session.id,
        reason: 'already-archived',
      } as const));
  }
  if (session.status !== 'IDLE') {
    return acceptTerminal(() =>
      skipCleanup(deps.attention, projectPath, event, `session-${session.status.toLowerCase()}`));
  }
  if (!session.projectPath || !session.worktreePath) {
    return acceptTerminal(() => skipCleanup(deps.attention, projectPath, event, 'missing-worktree'));
  }

  try {
    const status = await deps.git.status(session.worktreePath);
    if (!status.clean) {
      return acceptTerminal(() => skipCleanup(deps.attention, projectPath, event, 'dirty-worktree'));
    }
    const unpushed = await deps.git.unpushedCommits(session.worktreePath, {
      fallbackBase: session.baseBranch,
    });
    if (unpushed.commits.length > 0) {
      return acceptTerminal(() => skipCleanup(deps.attention, projectPath, event, 'unpushed-commits'));
    }
  } catch {
    return acceptTerminal(() => skipCleanup(deps.attention, projectPath, event, 'git-check-failed'));
  }

  let archived: ReturnType<SessionsService['archive']>;
  try {
    deps.assertDeliveryOwnership();
    archived = deps.sessions.archive(session.id);
  } catch {
    return acceptTerminal(() => skipCleanup(deps.attention, projectPath, event, 'archive-race'));
  }
  if (archived.status !== 'ARCHIVED') {
    return acceptTerminal(() => skipCleanup(deps.attention, projectPath, event, 'archive-pending'));
  }
  if (deps.sessionRecords.findActiveSuccessor(session.id, session.worktreePath)) {
    return acceptTerminal(() =>
      skipCleanup(deps.attention, projectPath, event, 'worktree-handed-off'));
  }
  deps.markCleanupCheckpoint();
  deps.assertDeliveryOwnership();
  const removal = await deps.git.removeWorktreeIfSafe(session.projectPath, session.worktreePath, {
    fallbackBase: session.baseBranch,
  });
  if (!removal.removed) {
    if (removal.reason === 'worktree-missing') {
      return acceptTerminal(() => {
        deps.sessionRecords.clearWorktreeMetadata(session.id);
        return skipCleanup(deps.attention, projectPath, event, removal.reason!);
      });
    }
    return acceptTerminal(() => skipCleanup(
        deps.attention,
        projectPath,
        event,
        removal.reason ?? 'worktree-removal-failed',
      ));
  }
  return acceptTerminal(() => {
    deps.sessionRecords.clearWorktreeMetadata(session.id);
    return {
      created: false,
      closed: true,
      archived: true,
      sessionId: session.id,
    } as const;
  });
}

function clearPullRequestAttention(
  attention: AttentionService,
  projectPath: string,
  event: ForgePullRequestWebhookEvent,
): void {
  attention.onConditionCleared('pr-review', `${projectPath}#${event.number}`);
  attention.onConditionCleared('pr-feedback', `${event.repoFullName}#${event.number}`);
  attention.onConditionCleared('pr-feedback', `${event.repoFullName}#${event.number}:delivery`);
  attention.onConditionCleared('pr-feedback', `${event.repoFullName}#${event.number}:cleanup`);
}

function skipCleanup(
  attention: AttentionService,
  projectPath: string,
  event: ForgePullRequestWebhookEvent,
  reason: string,
) {
  attention.raise({
    kind: 'pr-feedback',
    subjectId: `${event.repoFullName}#${event.number}:cleanup`,
    projectPath,
    title: `Merged PR #${event.number} cleanup skipped: ${reason}`,
    payload: { number: event.number, url: event.url ?? '', reason },
  });
  return { created: false, closed: true, reason } as const;
}
