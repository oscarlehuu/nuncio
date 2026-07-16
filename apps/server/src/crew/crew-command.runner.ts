import { Inject, Injectable, Optional } from '@nestjs/common';
import { rmSync } from 'node:fs';
import { type CrewSandboxLaunch, type CrewSandboxOptions } from './crew-command-sandbox';
import { CrewSandboxBackendRegistry } from './crew-sandbox-backend';

export interface CrewCommandResult {
  exitCode: number | null; stdout: string; stderr: string; durationMs: number;
  timedOut: boolean; aborted: boolean; spawnError: string | null; outputOverflow: boolean;
}

@Injectable()
export class CrewCommandRunner {
  private readonly backends: CrewSandboxBackendRegistry;

  constructor(
    @Optional() @Inject(CrewSandboxBackendRegistry) backends?: CrewSandboxBackendRegistry,
  ) {
    this.backends = backends ?? new CrewSandboxBackendRegistry();
  }

  async run(
    command: string, cwd: string, timeoutMs: number, maxOutputBytes = 16 * 1024 * 1024,
    signal?: AbortSignal,
    sandbox: CrewSandboxOptions = {},
  ): Promise<CrewCommandResult> {
    const startedAt = Date.now();
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 64 * 1024 * 1024) {
      throw new Error('Crew command output cap must be from 1 byte to 64 MiB');
    }
    // Backend selection is a clean, loud failure for an unknown name; it happens before the spawn
    // try so it is never masked as a captured spawn error. The profile resolver already rejects an
    // unknown backend, so this is a defensive backstop.
    const backend = this.backends.resolve(sandbox.backend);
    if (signal?.aborted) return {
      exitCode: null, stdout: '', stderr: '', durationMs: 0, timedOut: false,
      aborted: true, spawnError: null, outputOverflow: false,
    };
    let child: ReturnType<typeof Bun.spawn>;
    let tempDir: string | null = null;
    let launch: CrewSandboxLaunch | null = null;
    try {
      launch = backend.build(command, cwd, sandbox);
      tempDir = launch.tempDir;
      child = Bun.spawn(launch.argv, {
        cwd: launch.cwd, env: launch.env, stdout: 'pipe', stderr: 'pipe', detached: true,
      });
    } catch (error) {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      return {
        exitCode: null, stdout: '', stderr: '', durationMs: Date.now() - startedAt,
        timedOut: false, aborted: false,
        spawnError: error instanceof Error ? error.message : String(error), outputOverflow: false,
      };
    }
    let timedOut = false;
    let aborted = false;
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
    }, timeoutMs);
    const onAbort = () => { aborted = true; terminateGroup(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const budget: OutputBudget = {
      remaining: maxOutputBytes,
      overflow: false,
      onOverflow: terminateGroup,
    };
    try {
      const [stdout, stderr, settled] = await Promise.all([
        readCapped(child.stdout as ReadableStream<Uint8Array>, budget),
        readCapped(child.stderr as ReadableStream<Uint8Array>, budget),
        child.exited.then(
          (exitCode) => ({ exitCode, error: null as string | null }),
          (error) => ({ exitCode: null, error: error instanceof Error ? error.message : String(error) }),
        ),
      ]);
      return {
        exitCode: timedOut || aborted || budget.overflow ? null : settled.exitCode,
        stdout, stderr, durationMs: Date.now() - startedAt, timedOut, aborted,
        spawnError: settled.error, outputOverflow: budget.overflow,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Stop any confinement-owned resource the killed process group does not (e.g. a daemon-owned
      // container). Runs on every path; the host backend leaves this undefined. Guarded because
      // teardown must never mask the real result.
      try { launch?.onTerminate?.(); } catch { /* best-effort teardown */ }
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

interface OutputBudget {
  remaining: number;
  overflow: boolean;
  onOverflow(): void;
}

async function readCapped(stream: ReadableStream<Uint8Array>, budget: OutputBudget): Promise<string> {
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
      if (take < value.byteLength) {
        budget.overflow = true;
        budget.onOverflow();
      }
    }
  } catch {
    // A deliberate process-group kill can close the pipe abruptly; retained bytes remain valid evidence.
  }
  return Buffer.concat(chunks).toString('utf8');
}
