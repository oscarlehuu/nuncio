import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import {
  assertPathWithinRuntimeWorkspace,
  assertWritablePathWithinRuntimeWorkspace,
  canonicalRuntimePolicy,
} from '../agent-runtime-policy';
import type { AgentRuntimePolicy } from '../agents.types';
import {
  buildPolicyShellTool,
  POLICY_SHELL_TOOL_NAME,
  type PolicyShellMode,
  type PolicyShellSpawn,
} from '../tools/policy-shell-tool';

interface PiPolicyFactories {
  createReadTool(cwd: string, options?: unknown): unknown;
  createEditTool(cwd: string, options?: unknown): unknown;
  createWriteTool(cwd: string, options?: unknown): unknown;
  createGrepTool(cwd: string, options?: unknown): unknown;
  createLsTool(cwd: string, options?: unknown): unknown;
  defineTool?(tool: unknown): unknown;
}

export interface PiPolicyShellConfig {
  mode: PolicyShellMode;
  /** Test seams forwarded to the shell tool builder. */
  platform?: NodeJS.Platform;
  sandboxExecutable?: string;
  spawn?: PolicyShellSpawn;
}

export interface PiRuntimePolicyOptions {
  workspaceRoot: string;
  toolNames: string[];
  customTools: unknown[];
}

/**
 * Pi exposes operation-injected file tools. Its own shell would run arbitrary
 * host commands, so explicit policies replace it: workspace-write policies get
 * the Nuncio `bash` tool (OS-sandboxed when a backend is available, advisory
 * fallback under `auto` — see policy-shell-tool.ts), read-only policies get no
 * shell at all. Network-disabled and workspace confinement stay honest.
 */
export function buildPiRuntimePolicyOptions(
  policy: AgentRuntimePolicy,
  factories: PiPolicyFactories,
  shell?: PiPolicyShellConfig,
): PiRuntimePolicyOptions {
  const canonical = canonicalRuntimePolicy(policy);
  const root = canonical.workspaceRoot;
  const readGuard = (path: string) => assertPathWithinRuntimeWorkspace(root, path);
  const writeGuard = (path: string) => assertWritablePathWithinRuntimeWorkspace(root, path);

  const readTool = factories.createReadTool(root, {
    operations: {
      readFile: async (path: string) => readFile(readGuard(path)),
      access: async (path: string) => access(readGuard(path), constants.R_OK),
    },
  });
  const grepTool = factories.createGrepTool(root, {
    operations: {
      isDirectory: async (path: string) => (await stat(readGuard(path))).isDirectory(),
      readFile: async (path: string) => readFile(readGuard(path), 'utf8'),
    },
  });
  const lsTool = factories.createLsTool(root, {
    operations: {
      exists: async (path: string) => {
        try {
          await access(readGuard(path));
          return true;
        } catch (error) {
          if (error instanceof Error && error.message.includes('outside runtime workspace')) throw error;
          return false;
        }
      },
      stat: async (path: string) => stat(readGuard(path)),
      readdir: async (path: string) => readdir(readGuard(path)),
    },
  });

  if (canonical.filesystem === 'read-only') {
    return { workspaceRoot: root, toolNames: ['read', 'grep', 'ls'], customTools: [readTool, grepTool, lsTool] };
  }

  const editTool = factories.createEditTool(root, {
    operations: {
      readFile: async (path: string) => readFile(readGuard(path)),
      writeFile: async (path: string, content: string) => writeFile(writeGuard(path), content),
      access: async (path: string) => access(writeGuard(path), constants.R_OK | constants.W_OK),
    },
  });
  const writeTool = factories.createWriteTool(root, {
    operations: {
      writeFile: async (path: string, content: string) => writeFile(writeGuard(path), content),
      mkdir: async (path: string) => mkdir(writeGuard(path), { recursive: true }),
    },
  });
  const shellTool = shell
    ? buildPolicyShellTool({ workspaceRoot: root, ...shell }, factories.defineTool)
    : null;
  return {
    workspaceRoot: root,
    toolNames: [
      'read', 'edit', 'write', 'grep', 'ls',
      ...(shellTool ? [POLICY_SHELL_TOOL_NAME] : []),
    ],
    customTools: [
      readTool, editTool, writeTool, grepTool, lsTool,
      ...(shellTool ? [shellTool.tool] : []),
    ],
  };
}
