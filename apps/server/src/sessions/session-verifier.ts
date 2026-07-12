import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const VERIFY_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CHARS = 4000;

export interface VerifyCommand {
  argv: string[];
  /** Human-readable form stored in the event payload. */
  display: string;
  source: 'project-config' | 'project-file' | 'setting';
}

export interface VerifyRunResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
  timedOut: boolean;
}

/**
 * A project opts into verification by shipping `.nuncio/verify` (a shell
 * script run from the session's working directory); the machine-wide
 * NUNCIO_VERIFY_COMMAND setting is the fallback. No command → no verify.
 */
export function resolveVerifyCommand(
  workspace: string,
  settingCommand?: string | null,
): VerifyCommand | null {
  const script = join(workspace, '.nuncio', 'verify');
  if (existsSync(script)) {
    return { argv: ['sh', script], display: '.nuncio/verify', source: 'project-file' };
  }
  const inline = settingCommand?.trim();
  if (inline) {
    return { argv: ['sh', '-c', inline], display: inline, source: 'setting' };
  }
  return null;
}

/** How long to keep draining output pipes after the shell itself has exited. */
const OUTPUT_DRAIN_GRACE_MS = 500;
const FORCE_KILL_GRACE_MS = 150;

function killProcessTree(
  proc: ReturnType<typeof Bun.spawn>,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  try {
    if (process.platform !== 'win32' && proc.pid > 0) {
      // detached=true makes the verifier shell the leader of a new process
      // group. A negative pid reaches the shell and every inherited child.
      process.kill(-proc.pid, signal);
      return;
    }
  } catch {
    // The group may already have exited; fall back to the direct child below.
  }
  try {
    proc.kill(signal);
  } catch {
    // Idempotent teardown: an already-exited verifier needs no further action.
  }
}

export async function runVerifyCommand(
  command: VerifyCommand,
  cwd: string,
  timeoutMs = VERIFY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<VerifyRunResult> {
  const started = Date.now();
  if (signal?.aborted) throw signal.reason ?? new Error('Verification aborted');
  const proc = Bun.spawn(command.argv, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    detached: process.platform !== 'win32',
  });
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    killProcessTree(proc, 'SIGTERM');
    forceKillTimer ??= setTimeout(() => killProcessTree(proc, 'SIGKILL'), FORCE_KILL_GRACE_MS);
  };
  const onAbort = () => terminate();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const stdoutText = new Response(proc.stdout).text().catch(() => '');
  const stderrText = new Response(proc.stderr).text().catch(() => '');
  try {
    const exitCode = await proc.exited;
    const outputTexts = Promise.all([stdoutText, stderrText]);
    let settled = await Promise.race([
      outputTexts,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), OUTPUT_DRAIN_GRACE_MS)),
    ]);
    if (!settled) {
      // A normally-exited shell can leave a background child holding stdout or
      // stderr open. Reap the detached group, then preserve bytes the shell had
      // already written once the inherited descriptors close.
      killProcessTree(proc, 'SIGKILL');
      settled = await Promise.race([
        outputTexts,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FORCE_KILL_GRACE_MS)),
      ]);
    }
    const [stdout, stderr] = settled ?? ['', ''];
    const combinedOutput = `${stdout}${stderr}`;
    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      durationMs: Date.now() - started,
      outputTail: combinedOutput.slice(-OUTPUT_TAIL_CHARS),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    // The verifier owns the detached group. A successful shell may still have
    // spawned a background child with redirected pipes; it must not survive.
    killProcessTree(proc, 'SIGKILL');
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}
