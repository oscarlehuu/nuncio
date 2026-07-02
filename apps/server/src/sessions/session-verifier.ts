import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const VERIFY_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CHARS = 4000;

export interface VerifyCommand {
  argv: string[];
  /** Human-readable form stored in the event payload. */
  display: string;
  source: 'project-file' | 'setting';
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
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
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
