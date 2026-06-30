export interface CliAuthResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CliAuthRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<CliAuthResult>;

const CLI_AUTH_TIMEOUT_MS = 2500;

export async function githubCliToken(run: CliAuthRunner = runCli): Promise<string | null> {
  try {
    const result = await run('gh', ['auth', 'token'], CLI_AUTH_TIMEOUT_MS);
    if (result.exitCode !== 0) return null;
    const token = result.stdout.trim();
    return isTokenLike(token) ? token : null;
  } catch {
    return null;
  }
}

export async function gitlabCliToken(run: CliAuthRunner = runCli): Promise<string | null> {
  try {
    const result = await run('glab', ['auth', 'status', '-t'], CLI_AUTH_TIMEOUT_MS);
    if (result.exitCode !== 0) return null;
    const output = `${result.stdout}\n${result.stderr}`;
    const token = output.match(/Token found:\s*(\S+)/)?.[1]?.trim() ?? '';
    return isTokenLike(token) ? token : null;
  } catch {
    return null;
  }
}

async function runCli(command: string, args: string[], timeoutMs: number): Promise<CliAuthResult> {
  const proc = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<number>((resolve) => {
      timeout = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Process may have already exited; the timeout still means this auth attempt failed closed.
        }
        resolve(-1);
      }, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (exitCode === -1) {
    return { exitCode, stdout: '', stderr: '' };
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function isTokenLike(token: string): boolean {
  return token.length > 0 && !/\s/.test(token);
}
