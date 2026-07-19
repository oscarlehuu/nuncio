import { describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPiRuntimePolicyOptions } from '../../../src/agents/providers/pi-runtime-policy';

/**
 * Policy toolset assembly: read-only stays file-tools-only; workspace-write
 * gains the sandboxed `bash` tool per the shell mode (locked decisions 1–3,
 * plans/260719-engine-shell-and-compaction).
 */

const factories = {
  createReadTool: (cwd: string, options?: unknown) => ({ name: 'read', cwd, options }),
  createEditTool: (cwd: string, options?: unknown) => ({ name: 'edit', cwd, options }),
  createWriteTool: (cwd: string, options?: unknown) => ({ name: 'write', cwd, options }),
  createGrepTool: (cwd: string, options?: unknown) => ({ name: 'grep', cwd, options }),
  createLsTool: (cwd: string, options?: unknown) => ({ name: 'ls', cwd, options }),
  defineTool: (tool: unknown) => tool,
};

const SANDBOX_OK = { platform: 'darwin', sandboxExecutable: '/usr/bin/true' } as const;
const SANDBOX_MISSING = { platform: 'darwin', sandboxExecutable: '/missing/sandbox-exec' } as const;

function withWorkspace<T>(run: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-pi-policy-'));
  try {
    return run(realpathSync(workspaceRoot));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function policy(filesystem: 'read-only' | 'workspace-write', workspaceRoot: string) {
  return { filesystem, workspaceRoot, network: 'disabled' as const };
}

function toolNamesOf(options: { customTools: unknown[] }): string[] {
  return (options.customTools as Array<{ name: string }>).map((tool) => tool.name);
}

describe('buildPiRuntimePolicyOptions shell integration', () => {
  it('adds the sandboxed bash tool to workspace-write policies under auto', () => {
    withWorkspace((workspaceRoot) => {
      const options = buildPiRuntimePolicyOptions(
        policy('workspace-write', workspaceRoot),
        factories,
        { mode: 'auto', ...SANDBOX_OK },
      );
      expect(options.toolNames).toEqual(['read', 'edit', 'write', 'grep', 'ls', 'bash']);
      expect(toolNamesOf(options)).toContain('bash');
    });
  });

  it('never gives a read-only policy a shell, whatever the mode', () => {
    withWorkspace((workspaceRoot) => {
      const options = buildPiRuntimePolicyOptions(
        policy('read-only', workspaceRoot),
        factories,
        { mode: 'auto', ...SANDBOX_OK },
      );
      expect(options.toolNames).toEqual(['read', 'grep', 'ls']);
      expect(toolNamesOf(options)).not.toContain('bash');
    });
  });

  it('omits bash when the shell mode is off', () => {
    withWorkspace((workspaceRoot) => {
      const options = buildPiRuntimePolicyOptions(
        policy('workspace-write', workspaceRoot),
        factories,
        { mode: 'off', ...SANDBOX_OK },
      );
      expect(options.toolNames).toEqual(['read', 'edit', 'write', 'grep', 'ls']);
    });
  });

  it('omits bash under sandboxed-only when no sandbox backend is available', () => {
    withWorkspace((workspaceRoot) => {
      const options = buildPiRuntimePolicyOptions(
        policy('workspace-write', workspaceRoot),
        factories,
        { mode: 'sandboxed-only', ...SANDBOX_MISSING },
      );
      expect(options.toolNames).toEqual(['read', 'edit', 'write', 'grep', 'ls']);
    });
  });

  it('still provides an advisory bash under auto without a sandbox', () => {
    withWorkspace((workspaceRoot) => {
      const options = buildPiRuntimePolicyOptions(
        policy('workspace-write', workspaceRoot),
        factories,
        { mode: 'auto', ...SANDBOX_MISSING },
      );
      expect(options.toolNames).toContain('bash');
      const bash = (options.customTools as Array<{ name: string; description?: string }>)
        .find((tool) => tool.name === 'bash');
      expect(bash?.description).toContain('advisory');
    });
  });

  it('keeps the legacy no-shell shape when no shell config is passed', () => {
    withWorkspace((workspaceRoot) => {
      const options = buildPiRuntimePolicyOptions(
        policy('workspace-write', workspaceRoot),
        factories,
      );
      expect(options.toolNames).toEqual(['read', 'edit', 'write', 'grep', 'ls']);
    });
  });
});
