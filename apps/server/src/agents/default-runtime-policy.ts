import type { AgentCapabilities, AgentRuntimePolicy } from './agents.types';

/**
 * The Nuncio Engine provider id. Workspace-write confinement is a first-class
 * Nuncio Engine default only — legacy vendor engines (Cursor/Codex/Claude) keep
 * their existing runtime behavior (task-03 requirement 5).
 */
export const NUNCIO_ENGINE_PROVIDER_ID = 'pi';

export interface DefaultRuntimePolicyInput {
  /** Resolved per-session provider id. */
  providerId: string;
  /** The provider's advertised capabilities (used to check policy support). */
  capabilities: Pick<AgentCapabilities, 'runtimePolicies'>;
  /** Whether the create call already carries an explicit runtime policy. */
  hasExplicitPolicy: boolean;
  /** The session's effective workspace root (worktree or project dir). */
  workspace?: string | null;
  /** Global opt-out: confinement default is on unless the operator disables it. */
  confinementEnabled: boolean;
}

/**
 * Resolve the *default* runtime policy for a session at create time. Returns the
 * workspace-write policy to apply, or `null` to leave the session unconfined.
 *
 * Confinement is applied only when every condition holds:
 * - no explicit policy was supplied (an explicit one always wins),
 * - the global opt-out is enabled (default on),
 * - the engine is the Nuncio Engine,
 * - the session actually has a workspace (ad-hoc chats stay unconfined), and
 * - the engine advertises that it can enforce `workspace-write`/`disabled`.
 *
 * The returned policy reuses the existing `AgentRuntimePolicy` shape; canonical
 * validation (realpath + workspace match) happens through the normal
 * `assertRuntimePolicySupported` path in the session service.
 */
export function resolveDefaultRuntimePolicy(
  input: DefaultRuntimePolicyInput,
): AgentRuntimePolicy | null {
  if (input.hasExplicitPolicy) return null;
  if (!input.confinementEnabled) return null;
  if (input.providerId !== NUNCIO_ENGINE_PROVIDER_ID) return null;

  const workspace = input.workspace?.trim();
  if (!workspace) return null;

  const supportsWorkspaceWrite = input.capabilities.runtimePolicies?.some(
    (policy) => policy.filesystem === 'workspace-write' && policy.network === 'disabled',
  );
  if (!supportsWorkspaceWrite) return null;

  return { filesystem: 'workspace-write', workspaceRoot: workspace, network: 'disabled' };
}
