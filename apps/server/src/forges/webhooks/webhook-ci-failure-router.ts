import type { AttentionService } from '../../attention/attention.service';
import type { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import type { SessionsService } from '../../sessions/sessions.service';
import type { ForgeRepoService } from '../forges-repo.service';
import type { ForgeCiFailureWebhookEvent } from '../forges.types';
import type { WebhookDeliveryAcceptance } from './webhook-delivery-tracker';
import {
  raiseWebhookSteerFailure,
  webhookSteerFailureContext,
} from './webhook-steer-failure';

interface CiDependencies {
  sessions: SessionsService;
  sessionRecords: SessionsRepository;
  forgeRepos: ForgeRepoService;
  attention: AttentionService;
  accept: WebhookDeliveryAcceptance;
  enrichmentTimeoutMs?: number;
}

const CI_ENRICHMENT_TIMEOUT_MS = 2_000;

export async function routeWebhookCiFailure(
  deps: CiDependencies,
  provider: string,
  projectPath: string,
  event: ForgeCiFailureWebhookEvent,
) {
  const session = deps.sessionRecords.findByProjectPullRequest(projectPath, event.number);
  if (!session) {
    return deps.accept(() => {
      deps.attention.raise({
        kind: 'pr-feedback',
        subjectId: `${event.repoFullName}#${event.number}`,
        projectPath,
        title: `PR #${event.number} CI failed without an owning session`,
        payload: { provider, repo: event.repoFullName, number: event.number, url: event.url },
      });
      return { created: false, reason: 'no-owning-session' } as const;
    });
  }

  const enrichmentDeadline = Date.now() +
    (deps.enrichmentTimeoutMs ?? CI_ENRICHMENT_TIMEOUT_MS);
  const job = await resolveFailingJob(
    deps.forgeRepos,
    projectPath,
    event,
    enrichmentDeadline,
  );
  let log = '[Job log unavailable]';
  if (job.id !== null) {
    try {
      log = (await withinDeadline(
        deps.forgeRepos.getJobLog(projectPath, job.id),
        enrichmentDeadline,
      )).log;
    } catch {
      // External checks and expired logs may not expose a downloadable log.
    }
  }
  const prompt = [
    `CI failed for PR #${event.number}.`,
    `Job: ${job.name}`,
    `Run: ${event.url || `${event.repoFullName}#${event.number}`}`,
    '',
    'Failing job log tail:',
    '```text',
    log,
    '```',
    '',
    'Diagnose the failure, implement the fix, run the relevant checks, and update the pull request.',
  ].join('\n');
  const failureContext = webhookSteerFailureContext({
    provider,
    repo: event.repoFullName,
    number: event.number,
    url: event.url,
    projectPath,
    title: `PR #${event.number} CI failure could not be delivered to its session`,
  });
  try {
    return deps.accept(() => {
      deps.sessions.steerInBackground(
        session.id,
        prompt,
        undefined,
        undefined,
        `forge:${provider}:ci-failure`,
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

async function resolveFailingJob(
  forgeRepos: ForgeRepoService,
  projectPath: string,
  event: ForgeCiFailureWebhookEvent,
  enrichmentDeadline: number,
): Promise<{ id: number | null; name: string }> {
  if (event.jobId !== undefined) return { id: event.jobId, name: event.jobName };
  if (event.runId === undefined) return { id: null, name: event.jobName };
  let jobs: Awaited<ReturnType<ForgeRepoService['getWorkflowRunJobs']>>;
  try {
    jobs = await withinDeadline(
      forgeRepos.getWorkflowRunJobs(projectPath, event.runId),
      enrichmentDeadline,
    );
  } catch {
    return { id: null, name: event.jobName };
  }
  const failed = jobs.find((job) => ['failure', 'failed'].includes(job.conclusion ?? ''));
  return failed ? { id: failed.id, name: failed.name } : { id: null, name: event.jobName };
}

async function withinDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error('Forge enrichment timed out');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Forge enrichment timed out')),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
