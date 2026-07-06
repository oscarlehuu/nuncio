/**
 * The Claude permission bridge: maps the SDK's `canUseTool` callback onto
 * nuncio's existing provider-approval flow (the same binary approve/deny card
 * Codex uses) and translates the user's answer back into an SDK PermissionResult.
 *
 * Pure mapping lives here so the provider stays a thin lifecycle shell and the
 * tricky round-trips (title fallback, always-allow → updatedPermissions,
 * fail-closed deny) are unit-testable without spawning the SDK/CLI.
 */

import type { InteractionResponse } from '../agents.types';
import type { ProviderRequestInput } from '../../sessions/domain/sessions.types';

/** The permission-callback payload the provider reads (structural subset of the SDK's). */
export interface ClaudePermissionOptions {
  signal?: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID?: string;
  requestId: string;
}

export type ClaudePermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string };

/** The provider method that surfaces an approval card and resolves to the decision. */
export type RequestProviderApproval = (
  request: ProviderRequestInput,
) => Promise<{ requestId: string; decision: 'approve' | 'deny' }>;

const APPROVAL_METHOD = 'tool/approve';

/**
 * Build the approval request from the callback payload. Prompt text prefers the
 * bridge-rendered `title`; when absent (e.g. Write, per the spike) it composes
 * from displayName + description, falling back to the raw tool name.
 */
export function buildApprovalRequest(
  providerId: string,
  toolName: string,
  input: Record<string, unknown>,
  options: ClaudePermissionOptions,
): ProviderRequestInput {
  const prompt = resolvePromptText(toolName, options);
  return {
    provider: providerId,
    method: APPROVAL_METHOD,
    params: {
      prompt,
      toolName,
      input,
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
    },
  };
}

function resolvePromptText(toolName: string, options: ClaudePermissionOptions): string {
  if (options.title && options.title.trim()) return options.title;
  const label = options.displayName?.trim();
  const detail = options.description?.trim();
  if (label && detail) return `${label}: ${detail}`;
  if (label) return label;
  if (detail) return detail;
  return toolName;
}

/**
 * Translate an approve/deny decision into an SDK PermissionResult. `allow` must
 * echo the (possibly unchanged) input. When `alwaysAllow` is set the callback's
 * `suggestions` are returned as `updatedPermissions` so the SDK stops asking for
 * this tool in-session (the exact round-trip the typings document).
 */
export function decisionToPermissionResult(
  decision: 'approve' | 'deny',
  input: Record<string, unknown>,
  options: ClaudePermissionOptions,
  alwaysAllow = false,
): ClaudePermissionResult {
  if (decision === 'deny') {
    return { behavior: 'deny', message: 'Denied by nuncio approval policy.' };
  }
  const suggestions = options.suggestions ?? [];
  if (alwaysAllow && suggestions.length > 0) {
    return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions };
  }
  return { behavior: 'allow', updatedInput: input };
}

/** The fail-closed result used when a callback is aborted (dispose/interrupt) or unanswerable. */
export function denyResult(message = 'Denied by nuncio approval policy.'): ClaudePermissionResult {
  return { behavior: 'deny', message };
}

/**
 * Interpret a live-interaction response as an approve/deny plus an always-allow
 * flag. `skip` denies (fail-closed); an answer selecting an option id of
 * `always` (or `allow_always`) requests the updatedPermissions round-trip.
 */
export function interactionToDecision(response: InteractionResponse): {
  decision: 'approve' | 'deny';
  alwaysAllow: boolean;
} {
  if (response.resolvedBy === 'skip') return { decision: 'deny', alwaysAllow: false };
  const selected = response.answers.flatMap((answer) => answer.selectedOptionIds ?? []);
  if (selected.some((id) => id === 'deny' || id === 'reject')) {
    return { decision: 'deny', alwaysAllow: false };
  }
  const alwaysAllow = selected.some((id) => id === 'always' || id === 'allow_always');
  return { decision: 'approve', alwaysAllow };
}
