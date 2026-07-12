import {
  assertPathWithinRuntimeWorkspace,
  assertWritablePathWithinRuntimeWorkspace,
  canonicalRuntimePolicy,
} from '../agent-runtime-policy';
import type { AgentRuntimePolicy } from '../agents.types';
import type { ClaudePermissionResult } from './claude-agent.permissions';

type ClaudePolicyHook = (
  input: unknown,
  toolUseId?: string,
  options?: { signal?: AbortSignal },
) => Promise<Record<string, unknown>>;

export interface ClaudeRuntimePolicyOptions {
  workspaceRoot: string;
  permissionMode: 'default';
  tools: string[];
  hooks: { PreToolUse: Array<{ hooks: ClaudePolicyHook[] }> };
  authorizeTool(toolName: string, input: Record<string, unknown>): Promise<ClaudePermissionResult>;
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;
const WRITE_TOOLS = ['Edit', 'Write'] as const;

export function buildClaudeRuntimePolicyOptions(
  policy: AgentRuntimePolicy,
  trustedMcpToolNames: readonly string[] = [],
): ClaudeRuntimePolicyOptions {
  const canonical = canonicalRuntimePolicy(policy);
  const workspaceRoot = canonical.workspaceRoot;
  const filesystemTools = canonical.filesystem === 'read-only'
    ? [...READ_TOOLS]
    : [...READ_TOOLS, ...WRITE_TOOLS];
  const trustedMcpTools = [...new Set(trustedMcpToolNames)];
  const tools = [...filesystemTools, ...trustedMcpTools];

  const authorizeTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ClaudePermissionResult> => {
    if (trustedMcpTools.includes(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (!filesystemTools.includes(toolName as never)) {
      return { behavior: 'deny', message: `Tool ${toolName} is denied by runtime policy.` };
    }
    const path = toolPath(toolName, input);
    if (path === null) {
      return { behavior: 'deny', message: `Tool ${toolName} did not provide a valid path.` };
    }
    try {
      const guard = toolName === 'Edit' || toolName === 'Write'
        ? assertWritablePathWithinRuntimeWorkspace
        : assertPathWithinRuntimeWorkspace;
      guard(workspaceRoot, path ?? workspaceRoot);
      return { behavior: 'allow', updatedInput: input };
    } catch (error) {
      return {
        behavior: 'deny',
        message: error instanceof Error ? error.message : 'Path is outside runtime workspace.',
      };
    }
  };

  const hook: ClaudePolicyHook = async (value) => {
    const input = isRecord(value) ? value : {};
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
    const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
    const result = await authorizeTool(toolName, toolInput);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: result.behavior === 'allow' ? 'allow' : 'deny',
        permissionDecisionReason:
          result.behavior === 'deny' ? result.message : 'Allowed by Nuncio runtime policy.',
      },
    };
  };

  return {
    workspaceRoot,
    permissionMode: 'default',
    tools,
    hooks: { PreToolUse: [{ hooks: [hook] }] },
    authorizeTool,
  };
}

function toolPath(toolName: string, input: Record<string, unknown>): string | undefined | null {
  const key = toolName === 'Read' || toolName === 'Edit' || toolName === 'Write'
    ? 'file_path'
    : 'path';
  const value = input[key];
  if (value === undefined && (toolName === 'Grep' || toolName === 'Glob')) return undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
