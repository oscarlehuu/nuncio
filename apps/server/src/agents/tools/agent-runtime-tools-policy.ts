import type { AgentRuntimePolicy } from '../agents.types';
import type { AgentRuntimeTool, AgentRuntimeToolSecurity } from './agent-runtime-tools.types';

type CrewRuntimeTool = AgentRuntimeTool & { security: AgentRuntimeToolSecurity };

const trustedCrewTools = new WeakSet<object>();

/** Mark a statically-defined Crew tool as eligible for explicit-policy use. */
export function defineCrewRuntimeTool<T extends CrewRuntimeTool>(tool: T): T {
  trustedCrewTools.add(tool);
  return tool;
}

export function isCrewRuntimeToolAllowed(
  tool: AgentRuntimeTool,
  policy: AgentRuntimePolicy,
): boolean {
  if (!trustedCrewTools.has(tool)) return false;
  const security = tool.security;
  if (!isSecurityMetadata(security)) return false;
  if (security.scope !== 'crew-internal' || security.network !== 'disabled') return false;
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
  if (metadata.scope !== 'session' && metadata.scope !== 'crew-internal') return false;
  if (!Array.isArray(metadata.runtimePolicies) || metadata.runtimePolicies.length === 0) return false;
  return metadata.runtimePolicies.every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      (entry.filesystem === 'read-only' || entry.filesystem === 'workspace-write') &&
      entry.network === 'disabled',
  );
}
