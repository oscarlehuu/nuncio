import type { UsageProviderId, UsageSnapshotDto } from './usage-api';

const CLAUDE_MODEL_RE = /anthropic|claude|cliproxy|fable/i;

/**
 * Map a session/composer provider (+ optional model id) to a quota probe provider.
 * Pi sessions that route Claude/cliproxy models show Claude quota; otherwise null.
 */
export function resolveUsageProvider(
  sessionProvider: string | null | undefined,
  model?: string | null,
): UsageProviderId | null {
  if (sessionProvider === 'claude' || sessionProvider === 'codex' || sessionProvider === 'cursor') {
    return sessionProvider;
  }
  if (sessionProvider === 'pi') {
    const id = typeof model === 'string' ? model : '';
    if (CLAUDE_MODEL_RE.test(id)) {
      return 'claude';
    }
  }
  return null;
}

/** Return only the snapshot explicitly resolved for this session/model. */
export function findUsageSnapshotForProvider(
  snapshots: ReadonlyArray<UsageSnapshotDto>,
  provider: UsageProviderId | null,
): UsageSnapshotDto | null {
  if (provider === null) return null;
  return snapshots.find((snapshot) => snapshot.provider === provider) ?? null;
}

export function usageSignInCommand(provider: UsageProviderId): string {
  switch (provider) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex login';
    case 'cursor':
      return 'Open Cursor and sign in';
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export function usageNeedsAuthHint(provider: UsageProviderId): string {
  switch (provider) {
    case 'claude':
      return 'Sign in with `claude` to see usage.';
    case 'codex':
      return 'Sign in with `codex login` to see usage.';
    case 'cursor':
      return 'Sign in with Cursor to see usage.';
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}
