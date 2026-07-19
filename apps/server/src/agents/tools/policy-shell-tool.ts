import { rmSync } from 'node:fs';
import {
  buildRuntimeCommandSandboxLaunch,
  isRuntimeCommandSandboxAvailable,
  type RuntimeSandboxLaunch,
} from '../runtime-command-sandbox';

export const POLICY_SHELL_TOOL_NAME = 'bash';

/**
 * The `bash` tool for Pi runtime-policy sessions (workspace-write only).
 * Sandboxed mode wraps every command in the shared runtime command sandbox
 * (Seatbelt/bubblewrap: network denied, writes confined to the workspace,
 * `.git` and `.nuncio` read-only). Without a sandbox backend, `auto` mode
 * still provides the shell but announces that confinement is advisory —
 * never silently (locked decision 3, plans/260719-engine-shell-and-compaction).
 */

export type PolicyShellMode = 'auto' | 'sandboxed-only' | 'off';

export function resolvePolicyShellMode(raw: string | null | undefined): PolicyShellMode {
  const value = raw?.trim().toLowerCase();
  if (value === 'off') return 'off';
  if (value === 'sandboxed-only') return 'sandboxed-only';
  return 'auto';
}

interface PolicyShellSpawnResult {
  exitCode: number | null;
  /** Interleaved stdout + stderr, already capped by the spawner. */
  output: string;
  timedOut: boolean;
}

export type PolicyShellSpawn = (
  argv: string[],
  options: {
    cwd: string;
    /** Sandbox-scrubbed env for sandboxed launches; undefined inherits the process env. */
    env: Record<string, string> | undefined;
    timeoutMs: number;
    maxOutputChars: number;
  },
) => Promise<PolicyShellSpawnResult>;

export interface PolicyShellToolConfig {
  workspaceRoot: string;
  mode: PolicyShellMode;
  /** Test seams; production uses the process platform and default executables. */
  platform?: NodeJS.Platform;
  sandboxExecutable?: string;
  spawn?: PolicyShellSpawn;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface BuiltPolicyShellTool {
  sandboxed: boolean;
  tool: unknown;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
/** Workspace subpaths kept read-only inside the sandbox (defense in depth for the verify gate). */
const GATE_WRITE_DENY_SUBPATHS = ['.nuncio'];

const SANDBOXED_DESCRIPTION =
  'Run a shell command in the session workspace. Commands execute inside a Nuncio-enforced OS ' +
  'sandbox: network is disabled, writes are confined to the workspace (git metadata and the ' +
  '.nuncio verify gate stay read-only). Use it to run builds and tests before submitting.';

const ADVISORY_DESCRIPTION =
  'Run a shell command in the session workspace. No OS sandbox backend is available on this ' +
  'machine, so confinement is advisory: treat the network as unavailable and only write inside ' +
  'the workspace. Use it to run builds and tests before submitting.';

const PARAMETERS = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The shell command to execute (passed to /bin/sh -c) from the workspace root.',
    },
  },
  required: ['command'],
};

export function buildPolicyShellTool(
  config: PolicyShellToolConfig,
  defineTool?: (tool: unknown) => unknown,
): BuiltPolicyShellTool | null {
  if (config.mode === 'off') return null;
  const platform = config.platform ?? process.platform;
  const sandboxExecutable = config.sandboxExecutable
    ?? (platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap');
  const sandboxed = isRuntimeCommandSandboxAvailable(platform, sandboxExecutable);
  if (!sandboxed && config.mode === 'sandboxed-only') return null;

  const spawn = config.spawn ?? spawnShellCommand;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const wrap = defineTool ?? ((tool: unknown) => tool);

  const execute = async (_toolCallId: string, params: unknown) => {
    const input = (params ?? {}) as Record<string, unknown>;
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) {
      return {
        content: [{ type: 'text', text: 'bash ignored: pass a non-empty "command" string.' }],
        isError: true,
        details: {},
      };
    }
    let launch: RuntimeSandboxLaunch | null = null;
    try {
      let argv: string[];
      let env: Record<string, string> | undefined;
      if (sandboxed) {
        launch = buildRuntimeCommandSandboxLaunch(
          command,
          config.workspaceRoot,
          platform,
          sandboxExecutable,
          { extraWriteDenySubpaths: GATE_WRITE_DENY_SUBPATHS, tempDirPrefix: 'nuncio-policy-shell-' },
        );
        argv = launch.argv;
        env = launch.env;
      } else {
        argv = ['/bin/sh', '-c', command];
        env = undefined;
      }
      const result = await spawn(argv, {
        cwd: launch?.cwd ?? config.workspaceRoot,
        env,
        timeoutMs,
        maxOutputChars,
      });
      const text = formatResult(result, maxOutputChars);
      const failed = result.timedOut || result.exitCode !== 0;
      return {
        content: [{ type: 'text', text }],
        ...(failed ? { isError: true } : {}),
        details: {},
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `bash failed to start: ${reason}` }],
        isError: true,
        details: {},
      };
    } finally {
      if (launch) rmSync(launch.tempDir, { recursive: true, force: true });
    }
  };

  return {
    sandboxed,
    tool: wrap({
      name: POLICY_SHELL_TOOL_NAME,
      label: 'Shell',
      description: sandboxed ? SANDBOXED_DESCRIPTION : ADVISORY_DESCRIPTION,
      parameters: PARAMETERS,
      execute,
    }),
  };
}

function formatResult(result: PolicyShellSpawnResult, maxOutputChars: number): string {
  let output = result.output;
  if (output.length > maxOutputChars) {
    // Build/test failures live at the end of the stream — keep the tail.
    output = `[output truncated: kept the last ${maxOutputChars} characters]\n`
      + output.slice(-maxOutputChars);
  }
  if (result.timedOut) {
    return `Command timed out and was killed.\n${output}`.trimEnd();
  }
  if (result.exitCode !== 0) {
    return `Command failed with exit code ${result.exitCode ?? 'unknown'}.\n${output}`.trimEnd();
  }
  return output.trim() ? output : '(no output)';
}

/** Production spawner: process-group kill on timeout, byte-capped interleaved output. */
async function spawnShellCommand(
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string> | undefined;
    timeoutMs: number;
    maxOutputChars: number;
  },
): Promise<PolicyShellSpawnResult> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  let timedOut = false;
  let terminated = false;
  const terminateGroup = () => {
    if (terminated) return;
    terminated = true;
    try {
      globalThis.process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* process already exited */ }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminateGroup();
  }, options.timeoutMs);
  // Retain a generous byte budget; the tool layer trims to maxOutputChars afterwards so the
  // truncation notice can say what was kept.
  const budget = { remaining: Math.max(options.maxOutputChars * 8, 1 << 20) };
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(child.stdout as ReadableStream<Uint8Array>, budget, terminateGroup),
      readCapped(child.stderr as ReadableStream<Uint8Array>, budget, terminateGroup),
      child.exited.then(
        (code) => code,
        () => null as number | null,
      ),
    ]);
    const output = [stdout, stderr].filter(Boolean).join('\n');
    return { exitCode: timedOut ? null : exitCode, output, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  budget: { remaining: number },
  onOverflow: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = Math.min(value.byteLength, budget.remaining);
      if (take > 0) {
        chunks.push(value.subarray(0, take));
        budget.remaining -= take;
      }
      if (take < value.byteLength) onOverflow();
    }
  } catch {
    // A deliberate process-group kill can close the pipe abruptly; retained bytes stay valid.
  }
  return Buffer.concat(chunks).toString('utf8');
}
