import { canonicalRuntimePolicy } from '../agent-runtime-policy';
import type { AgentRuntimePolicy } from '../agents.types';

type CodexSandboxPolicy =
  | { type: 'readOnly'; networkAccess: false }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: false;
      excludeTmpdirEnvVar: true;
      excludeSlashTmp: true;
    };

export interface CodexRuntimePolicyMapping {
  workspaceRoot: string;
  thread: {
    approvalPolicy: 'never';
    sandbox: 'read-only' | 'workspace-write';
    runtimeWorkspaceRoots: string[];
  };
  turn: {
    approvalPolicy: 'never';
    sandboxPolicy: CodexSandboxPolicy;
    cwd: string;
    runtimeWorkspaceRoots: string[];
  };
}

/** Mapping verified against `codex app-server generate-ts` from CLI 0.144.1. */
export function mapCodexRuntimePolicy(policy: AgentRuntimePolicy): CodexRuntimePolicyMapping {
  const canonical = canonicalRuntimePolicy(policy);
  const workspaceRoot = canonical.workspaceRoot;
  const common = { approvalPolicy: 'never' as const, runtimeWorkspaceRoots: [workspaceRoot] };
  if (canonical.filesystem === 'read-only') {
    return {
      workspaceRoot,
      thread: { ...common, sandbox: 'read-only' },
      turn: {
        ...common,
        cwd: workspaceRoot,
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      },
    };
  }
  return {
    workspaceRoot,
    thread: { ...common, sandbox: 'workspace-write' },
    turn: {
      ...common,
      cwd: workspaceRoot,
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [workspaceRoot],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    },
  };
}
