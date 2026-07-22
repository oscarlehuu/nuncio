import type { AgentRuntimePolicy } from '../agents.types';
import type { AgentRuntimeTool, AgentRuntimeToolSecurity } from './agent-runtime-tools.types';

type TrustedRuntimeTool = AgentRuntimeTool & { security: AgentRuntimeToolSecurity };

const trustedRuntimeTools = new WeakSet<object>();

/** Mark a statically-defined runtime tool as eligible for explicit-policy use. */
export function defineTrustedRuntimeTool<T extends TrustedRuntimeTool>(tool: T): T {
  trustedRuntimeTools.add(tool);
  return tool;
}

export function isTrustedRuntimeToolAllowed(
  tool: AgentRuntimeTool,
  policy: AgentRuntimePolicy,
): boolean {
  if (!trustedRuntimeTools.has(tool)) return false;
  const security = tool.security;
  if (!isSecurityMetadata(security)) return false;
  if (security.scope !== 'policy-internal' || security.network !== 'disabled') return false;
  if (policy.filesystem === 'read-only' && security.workspaceMutation !== 'none') return false;
  return security.runtimePolicies.some(
    (supported) =>
      supported.filesystem === policy.filesystem && supported.network === policy.network,
  );
}

function isSecurityMetadata(value: unknown): value is AgentRuntimeToolSecurity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const metadata = value as Partial<AgentRuntimeToolSecurity>;
  if (metadata.network !== 'disabled' && metadata.network !== 'required') return false;
  if (metadata.workspaceMutation !== 'none' && metadata.workspaceMutation !== 'workspace') return false;
  if (metadata.scope !== 'session' && metadata.scope !== 'policy-internal') return false;
  if (!Array.isArray(metadata.runtimePolicies) || metadata.runtimePolicies.length === 0) return false;
  return metadata.runtimePolicies.every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      (entry.filesystem === 'read-only' || entry.filesystem === 'workspace-write') &&
      entry.network === 'disabled',
  );
}
