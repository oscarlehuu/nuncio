import { describe, expect, it } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPolicyShellTool,
  POLICY_SHELL_TOOL_NAME,
  resolvePolicyShellMode,
  type PolicyShellSpawn,
} from '../../../src/agents/tools/policy-shell-tool';
import { isRuntimeCommandSandboxAvailable } from '../../../src/agents/runtime-command-sandbox';

/**
 * The Pi policy shell tool: a `bash` custom tool for runtime-policy sessions.
 * Sandboxed through the shared runtime command sandbox when a backend is
 * available; a plain, honestly-announced fallback otherwise (locked decision:
 * the shell exists even without a sandbox, `sandboxed-only` tightens it).
 */

interface SpawnCall {
  argv: string[];
  cwd: string;
  env: Record<string, string> | undefined;
  timeoutMs: number;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface PiToolLike {
  name: string;
  description: string;
  execute(toolCallId: string, params: unknown): Promise<ToolResult>;
}

function makeSpawn(
  result: { exitCode?: number | null; output?: string; timedOut?: boolean } = {},
): { spawn: PolicyShellSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: PolicyShellSpawn = async (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs });
    return {
      exitCode: result.exitCode === undefined ? 0 : result.exitCode,
      output: result.output ?? 'ok',
      timedOut: result.timedOut ?? false,
    };
  };
  return { spawn, calls };
}

/** Sandboxed builds probe the executable — /usr/bin/true always "launches". */
const SANDBOX_OK = { platform: 'darwin', sandboxExecutable: '/usr/bin/true' } as const;

function withWorkspace<T>(run: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-shell-tool-'));
  try {
    return run(realpathSync(workspaceRoot));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

describe('resolvePolicyShellMode', () => {
  it('maps known values and defaults everything else to auto', () => {
    expect(resolvePolicyShellMode('off')).toBe('off');
    expect(resolvePolicyShellMode('sandboxed-only')).toBe('sandboxed-only');
    expect(resolvePolicyShellMode('auto')).toBe('auto');
    expect(resolvePolicyShellMode(' Sandboxed-Only ')).toBe('sandboxed-only');
    expect(resolvePolicyShellMode(undefined)).toBe('auto');
    expect(resolvePolicyShellMode('')).toBe('auto');
    expect(resolvePolicyShellMode('garbage')).toBe('auto');
  });
});

describe('buildPolicyShellTool', () => {
  it('returns null when the shell is switched off', () => {
    withWorkspace((workspaceRoot) => {
      expect(buildPolicyShellTool({ workspaceRoot, mode: 'off', ...SANDBOX_OK })).toBeNull();
    });
  });

  it('returns null under sandboxed-only when no sandbox backend is available', () => {
    withWorkspace((workspaceRoot) => {
      expect(
        buildPolicyShellTool({
          workspaceRoot,
          mode: 'sandboxed-only',
          platform: 'darwin',
          sandboxExecutable: '/missing/sandbox-exec',
        }),
      ).toBeNull();
    });
  });

  it('builds a sandboxed bash tool whose description states the enforced confinement', () => {
    withWorkspace((workspaceRoot) => {
      const built = buildPolicyShellTool({ workspaceRoot, mode: 'auto', ...SANDBOX_OK });
      expect(built).not.toBeNull();
      expect(built!.sandboxed).toBe(true);
      const tool = built!.tool as PiToolLike;
      expect(tool.name).toBe(POLICY_SHELL_TOOL_NAME);
      expect(tool.description).toContain('network is disabled');
      expect(tool.description).not.toContain('advisory');
    });
  });

  it('falls back to an announced advisory shell under auto without a sandbox', () => {
    withWorkspace((workspaceRoot) => {
      const built = buildPolicyShellTool({
        workspaceRoot,
        mode: 'auto',
        platform: 'darwin',
        sandboxExecutable: '/missing/sandbox-exec',
      });
      expect(built).not.toBeNull();
      expect(built!.sandboxed).toBe(false);
      expect((built!.tool as PiToolLike).description).toContain('advisory');
    });
  });

  it('executes sandboxed commands through the sandbox argv and cleans the temp dir', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const { spawn, calls } = makeSpawn({ output: 'test output' });
      const built = buildPolicyShellTool({ workspaceRoot, mode: 'auto', ...SANDBOX_OK, spawn })!;
      const result = await (built.tool as PiToolLike).execute('call-1', { command: 'bun test' });

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.argv[0]).toBe('/usr/bin/true');
      const profile = call.argv[2]!;
      expect(profile).toContain('(deny network*)');
      expect(profile).toContain(JSON.stringify(join(workspaceRoot, '.nuncio')));
      expect(profile).toContain(JSON.stringify(join(workspaceRoot, '.git')));
      expect(call.argv.at(-1)).toBe('bun test');
      expect(call.cwd).toBe(workspaceRoot);
      const tempDir = call.env?.HOME;
      expect(tempDir).toBeString();
      expect(existsSync(tempDir!)).toBe(false);
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('test output');
    });
  });

  it('executes advisory commands as a plain shell in the workspace', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const { spawn, calls } = makeSpawn({ output: 'plain' });
      const built = buildPolicyShellTool({
        workspaceRoot,
        mode: 'auto',
        platform: 'darwin',
        sandboxExecutable: '/missing/sandbox-exec',
        spawn,
      })!;
      await (built.tool as PiToolLike).execute('call-1', { command: 'echo hi' });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.argv).toEqual(['/bin/sh', '-c', 'echo hi']);
      expect(calls[0]!.cwd).toBe(workspaceRoot);
      expect(calls[0]!.env).toBeUndefined();
    });
  });

  it('surfaces a nonzero exit code as a tool error with the retained output', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const { spawn } = makeSpawn({ exitCode: 2, output: 'boom' });
      const built = buildPolicyShellTool({ workspaceRoot, mode: 'auto', ...SANDBOX_OK, spawn })!;
      const result = await (built.tool as PiToolLike).execute('call-1', { command: 'false' });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('exit code 2');
      expect(result.content[0]!.text).toContain('boom');
    });
  });

  it('reports a timeout as a tool error', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const { spawn } = makeSpawn({ exitCode: null, timedOut: true, output: 'partial' });
      const built = buildPolicyShellTool({
        workspaceRoot, mode: 'auto', ...SANDBOX_OK, spawn, timeoutMs: 1234,
      })!;
      const result = await (built.tool as PiToolLike).execute('call-1', { command: 'sleep 99' });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('timed out');
      expect(result.content[0]!.text).toContain('partial');
    });
  });

  it('keeps the tail of oversized output and says so', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const long = `${'x'.repeat(500)}TAIL`;
      const { spawn } = makeSpawn({ output: long });
      const built = buildPolicyShellTool({
        workspaceRoot, mode: 'auto', ...SANDBOX_OK, spawn, maxOutputChars: 100,
      })!;
      const result = await (built.tool as PiToolLike).execute('call-1', { command: 'yes' });

      expect(result.content[0]!.text).toContain('truncated');
      expect(result.content[0]!.text).toContain('TAIL');
      expect(result.content[0]!.text.length).toBeLessThan(400);
    });
  });

  it('rejects a missing or empty command without spawning', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const { spawn, calls } = makeSpawn();
      const built = buildPolicyShellTool({ workspaceRoot, mode: 'auto', ...SANDBOX_OK, spawn })!;
      const missing = await (built.tool as PiToolLike).execute('call-1', {});
      const empty = await (built.tool as PiToolLike).execute('call-2', { command: '   ' });

      expect(missing.isError).toBe(true);
      expect(empty.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  // Proves the host OS actually enforces the contract (Seatbelt or bubblewrap), not just that
  // the launch args are shaped right — same live pattern as the Crew sandbox ecosystem spec.
  it('enforces workspace confinement and the .nuncio gate inside the real sandbox', async () => {
    if (!isRuntimeCommandSandboxAvailable()) return; // no backend here — advisory path covered above
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'nuncio-shell-live-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'nuncio-shell-live-outside-')));
    mkdirSync(join(workspaceRoot, '.nuncio'));
    writeFileSync(join(workspaceRoot, '.nuncio', 'verify'), '#!/bin/sh\nexit 1\n');
    try {
      const built = buildPolicyShellTool({ workspaceRoot, mode: 'sandboxed-only', timeoutMs: 10_000 })!;
      expect(built.sandboxed).toBe(true);
      const tool = built.tool as PiToolLike;

      const inside = await tool.execute('live-1', { command: 'printf hello > out.txt && cat out.txt' });
      expect(inside.isError).toBeUndefined();
      expect(readFileSync(join(workspaceRoot, 'out.txt'), 'utf8')).toBe('hello');

      const escape = await tool.execute('live-2', {
        command: `printf x > ${JSON.stringify(join(outside, 'intrude.txt'))}`,
      });
      expect(escape.isError).toBe(true);
      expect(existsSync(join(outside, 'intrude.txt'))).toBe(false);

      const gate = await tool.execute('live-3', { command: 'printf "exit 0" > .nuncio/verify' });
      expect(gate.isError).toBe(true);
      expect(readFileSync(join(workspaceRoot, '.nuncio', 'verify'), 'utf8')).toContain('exit 1');

      const network = await tool.execute('live-4', {
        command: '/usr/bin/curl -sS -m 3 https://example.com && echo REACHED',
      });
      expect(network.isError).toBe(true);
      expect(network.content[0]!.text).not.toContain('REACHED');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 20_000);

  it('wraps the definition through defineTool when provided', () => {
    withWorkspace((workspaceRoot) => {
      const seen: unknown[] = [];
      const defineTool = (tool: unknown) => {
        seen.push(tool);
        return { wrapped: tool };
      };
      const built = buildPolicyShellTool(
        { workspaceRoot, mode: 'auto', ...SANDBOX_OK },
        defineTool,
      )!;
      expect(seen).toHaveLength(1);
      expect(built.tool).toEqual({ wrapped: seen[0] });
    });
  });
});
