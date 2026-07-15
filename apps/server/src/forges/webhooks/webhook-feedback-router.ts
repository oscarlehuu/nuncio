import type { AttentionService } from '../../attention/attention.service';
import type { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import type { SessionsService } from '../../sessions/sessions.service';
import type { ForgesService } from '../forges.service';
import type { ForgePullRequestFeedbackWebhookEvent } from '../forges.types';
import type { WebhookDeliveryAcceptance } from './webhook-delivery-tracker';
import {
  raiseWebhookSteerFailure,
  webhookSteerFailureContext,
} from './webhook-steer-failure';

interface FeedbackDependencies {
  sessions: SessionsService;
  sessionRecords: SessionsRepository;
  forges: ForgesService;
  attention: AttentionService;
  accept: WebhookDeliveryAcceptance;
}

export async function routeWebhookFeedback(
  deps: FeedbackDependencies,
  provider: string,
  projectPath: string,
  event: ForgePullRequestFeedbackWebhookEvent,
) {
  const session = deps.sessionRecords.findByProjectPullRequest(projectPath, event.number);
  const author = event.author.trim();
  const statuses = await deps.forges.listStatus();
  const login = statuses.find((status) => status.id === provider)?.login?.trim();
  if (author && login && author.toLowerCase() === login.toLowerCase()) {
    return deps.accept(() => ({ created: false, reason: 'own-forge-author' } as const));
  }
  if (!session) {
    return deps.accept(() => {
      deps.attention.raise({
        kind: 'pr-feedback',
        subjectId: `${event.repoFullName}#${event.number}`,
        projectPath,
        title: `PR #${event.number} received feedback without an owning session`,
        payload: {
          provider,
          repo: event.repoFullName,
          number: event.number,
          url: event.url,
          author: event.author,
        },
      });
      return { created: false, reason: 'no-owning-session' } as const;
    });
  }

  if (!author) {
    return deps.accept(() => {
      raiseUntrustedFeedbackAttention(deps.attention, provider, projectPath, event, 'missing-feedback-author');
      return { created: false, reason: 'missing-feedback-author' } as const;
    });
  }
  // If identity cannot be established, steering could feed Nuncio's own output
  // back into the same session. Attention preserves the feedback without executing it.
  if (!login) {
    return deps.accept(() => {
      raiseUntrustedFeedbackAttention(deps.attention, provider, projectPath, event, 'forge-login-unavailable');
      return { created: false, reason: 'forge-login-unavailable' } as const;
    });
  }

  const trustedAuthor = await deps.forges.canAuthorWriteRepository(
    provider,
    { owner: event.owner, repo: event.repo },
    author,
  );
  if (!trustedAuthor) {
    return deps.accept(() => {
      raiseUntrustedFeedbackAttention(deps.attention, provider, projectPath, event, 'untrusted-author');
      return { created: false, reason: 'untrusted-feedback-author' } as const;
    });
  }

  const failureContext = webhookSteerFailureContext({
    provider,
    repo: event.repoFullName,
    number: event.number,
    url: event.url,
    projectPath,
    title: `PR #${event.number} feedback could not be delivered to its session`,
  });
  try {
    return deps.accept(() => {
      deps.sessions.steerInBackground(
        session.id,
        buildFeedbackPrompt(event),
        undefined,
        undefined,
        `forge:${provider}:pr-feedback`,
        failureContext,
      );
      return { created: false, steered: true, sessionId: session.id } as const;
    });
  } catch (error) {
    return deps.accept(() => {
      raiseWebhookSteerFailure(deps.attention, failureContext, error);
      return {
        created: false,
        reason: 'background-steer-failed',
        sessionId: session.id,
      } as const;
    });
  }
}

function raiseUntrustedFeedbackAttention(
  attention: AttentionService,
  provider: string,
  projectPath: string,
  event: ForgePullRequestFeedbackWebhookEvent,
  reason: string,
): void {
  attention.raise({
    kind: 'pr-feedback',
    subjectId: `${event.repoFullName}#${event.number}`,
    projectPath,
    title: `PR #${event.number} received feedback from an untrusted author`,
    payload: {
      provider,
      repo: event.repoFullName,
      number: event.number,
      url: event.url,
      author: event.author,
      reviewState: event.reviewState ?? null,
      comments: event.comments,
      reason,
    },
  });
}

function buildFeedbackPrompt(event: ForgePullRequestFeedbackWebhookEvent): string {
  const lines = [
    `Forge feedback received for PR #${event.number}.`,
    `Author: ${event.author || 'unknown'}`,
    ...(event.reviewState ? [`Review state: ${event.reviewState}`] : []),
    `PR: ${event.url || `${event.repoFullName}#${event.number}`}`,
    '',
  ];
  for (const comment of event.comments) {
    const location = comment.path
      ? ` (${comment.path}${comment.line ? `:${comment.line}` : ''})`
      : '';
    lines.push(`Comment${location}:`, comment.body || '[No comment body]', '');
  }
  lines.push('Address the actionable feedback, verify the change, and update the pull request.');
  return lines.join('\n').trim();
}
