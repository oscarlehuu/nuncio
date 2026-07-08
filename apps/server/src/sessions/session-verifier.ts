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

export async function runVerifyCommand(
  command: VerifyCommand,
  cwd: string,
  timeoutMs = VERIFY_TIMEOUT_MS,
): Promise<VerifyRunResult> {
  const started = Date.now();
  const proc = Bun.spawn(command.argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const stdoutText = new Response(proc.stdout).text().catch(() => '');
  const stderrText = new Response(proc.stderr).text().catch(() => '');
  try {
    const exitCode = await proc.exited;
    // Grandchildren of the shell can inherit the pipes and keep them open past
    // the shell's death (e.g. a killed `sh -c` whose child lives on). Buffered
    // output is available immediately after exit, so cap the drain.
    const drain = (text: Promise<string>) =>
      Promise.race([
        text,
        new Promise<string>((resolve) => setTimeout(() => resolve(''), OUTPUT_DRAIN_GRACE_MS)),
      ]);
    const [stdout, stderr] = await Promise.all([drain(stdoutText), drain(stderrText)]);
    const output = `${stdout}${stderr}`;
    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      durationMs: Date.now() - started,
      outputTail: output.slice(-OUTPUT_TAIL_CHARS),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}
