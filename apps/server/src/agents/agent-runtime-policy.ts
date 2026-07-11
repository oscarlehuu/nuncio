import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AgentCapabilities,
  AgentRuntimePolicy,
  AgentRuntimePolicySupport,
} from './agents.types';
import type { AgentRuntimeTools } from './tools/agent-runtime-tools.types';
import { isCrewRuntimeToolAllowed } from './tools/agent-runtime-tools-policy';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAgentRuntimePolicy(raw: string | null | undefined): AgentRuntimePolicy | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Stored agent runtime policy is not valid JSON.');
  }
  return validatePolicyShape(parsed);
}

export function stringifyAgentRuntimePolicy(
  policy: AgentRuntimePolicy | null | undefined,
): string | null {
  return policy ? JSON.stringify(validatePolicyShape(policy)) : null;
}

export function validatePolicyShape(value: unknown): AgentRuntimePolicy {
  if (!isRecord(value)) throw new Error('Agent runtime policy must be an object.');
  const { filesystem, workspaceRoot, network } = value;
  if (filesystem !== 'read-only' && filesystem !== 'workspace-write') {
    throw new Error('Agent runtime policy has an unsupported filesystem mode.');
  }
  if (network !== 'disabled') {
    throw new Error('Agent runtime policy network access must be disabled.');
  }
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) {
    throw new Error('Agent runtime policy workspaceRoot must be an absolute path.');
  }
  return { filesystem, workspaceRoot, network };
}

export function canonicalRuntimePolicy(policy: AgentRuntimePolicy): AgentRuntimePolicy {
  const validated = validatePolicyShape(policy);
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(validated.workspaceRoot);
  } catch {
    throw new Error(`Agent runtime policy workspace does not exist: ${validated.workspaceRoot}`);
  }
  return { ...validated, workspaceRoot };
}

export function assertRuntimePolicySupported(
  policy: AgentRuntimePolicy | null | undefined,
  capabilities: AgentCapabilities,
  effectiveWorkspace?: string | null,
): AgentRuntimePolicy | undefined {
  const validated = assertRuntimePolicyCapabilitySupported(policy, capabilities);
  if (!validated) return undefined;
  const canonical = canonicalRuntimePolicy(validated);
  if (!effectiveWorkspace) {
    throw new Error('Agent runtime policy requires a session workspace.');
  }
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = realpathSync(effectiveWorkspace);
  } catch {
    throw new Error(`Session workspace does not exist: ${effectiveWorkspace}`);
  }
  if (canonicalWorkspace !== canonical.workspaceRoot) {
    throw new Error('Agent runtime policy workspaceRoot must match the session workspace.');
  }
  return canonical;
}

export function assertRuntimePolicyCapabilitySupported(
  policy: AgentRuntimePolicy | null | undefined,
  capabilities: AgentCapabilities,
): AgentRuntimePolicy | undefined {
  if (!policy) return undefined;
  const validated = validatePolicyShape(policy);
  const support: AgentRuntimePolicySupport = {
    filesystem: validated.filesystem,
    network: validated.network,
  };
  const supported = capabilities.runtimePolicies?.some(
    (entry) => entry.filesystem === support.filesystem && entry.network === support.network,
  );
  if (!supported) {
    throw new Error(
      `Provider does not support runtime policy ${support.filesystem}/${support.network}.`,
    );
  }
  return validated;
}

export function runtimePolicyKey(policy: AgentRuntimePolicy | null | undefined): string {
  return policy ? JSON.stringify(validatePolicyShape(policy)) : 'solo';
}

export function runtimeToolsForPolicy(
  policy: AgentRuntimePolicy | null | undefined,
  tools: AgentRuntimeTools | undefined,
): AgentRuntimeTools | undefined {
  if (!policy) return tools;
  const allowed = tools?.tools.filter((tool) => isCrewRuntimeToolAllowed(tool, policy)) ?? [];
  // Aggregate prompt text may describe excluded browser/orchestration tools, so
  // explicit-policy runs receive only the independently-vetted tool objects.
  return allowed.length > 0 ? { tools: allowed } : undefined;
}

export function assertPathWithinRuntimeWorkspace(
  workspaceRoot: string,
  requestedPath: string,
): string {
  if (!requestedPath || requestedPath.includes('\0') || requestedPath.startsWith('~')) {
    throw new Error('Path is outside runtime workspace.');
  }
  const root = realpathSync(workspaceRoot);
  const candidate = resolve(root, requestedPath);

  let existing = candidate;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('Path is outside runtime workspace.');
    existing = parent;
  }
  const canonicalExisting = realpathSync(existing);
  assertContained(root, canonicalExisting);
  const canonicalCandidate = resolve(canonicalExisting, relative(existing, candidate));
  assertContained(root, canonicalCandidate);
  return existsSync(candidate) ? realpathSync(candidate) : canonicalCandidate;
}

/** Workspace writes never include Git control metadata, including pointer files. */
export function assertWritablePathWithinRuntimeWorkspace(
  workspaceRoot: string,
  requestedPath: string,
): string {
  const candidate = assertPathWithinRuntimeWorkspace(workspaceRoot, requestedPath);
  const root = realpathSync(workspaceRoot);
  const fromRoot = relative(root, candidate);
  if (fromRoot === '.git' || fromRoot.startsWith(`.git${sep}`)) {
    throw new Error('Git metadata is read-only under the runtime policy.');
  }
  return candidate;
}

function assertContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) return;
  throw new Error('Path is outside runtime workspace.');
}
