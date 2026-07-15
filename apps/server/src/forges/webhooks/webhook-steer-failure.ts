import type { AttentionService } from '../../attention/attention.service';

export function webhookSteerFailureContext(input: {
  provider: string;
  repo: string;
  number: number;
  url: string;
  projectPath: string;
  title: string;
}): Record<string, unknown> {
  return {
    kind: 'pr-feedback',
    subjectId: `${input.repo}#${input.number}`,
    projectPath: input.projectPath,
    title: input.title,
    payload: {
      provider: input.provider,
      repo: input.repo,
      number: input.number,
      url: input.url,
      reason: 'background-steer-failed',
    },
  };
}

export function raiseWebhookSteerFailure(
  attention: AttentionService,
  context: Record<string, unknown>,
  error: unknown,
): void {
  if (
    context.kind !== 'pr-feedback' ||
    typeof context.subjectId !== 'string' ||
    typeof context.title !== 'string'
  ) return;
  const payload = context.payload && typeof context.payload === 'object'
    ? context.payload as Record<string, unknown>
    : {};
  attention.raise({
    kind: context.kind,
    subjectId: context.subjectId,
    projectPath: typeof context.projectPath === 'string' ? context.projectPath : null,
    title: context.title,
    payload: {
      ...payload,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}
