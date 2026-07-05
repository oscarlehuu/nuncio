import { homedir } from 'node:os';
import { delimiter } from 'node:path';

export interface CliAuthResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Directories where `gh`/`glab` are commonly installed. A desktop app launched
// from Finder/Dock inherits a minimal PATH (often just /usr/bin:/bin), so a bare
// `gh`/`glab` spawn fails with ENOENT even when the CLI is installed and
// authenticated — which surfaces as "Forge provider github is not available".
// Appending these fallbacks keeps CLI auth working outside a login shell while
// still honoring a `gh`/`glab` that the user's own PATH already resolves.
const CLI_FALLBACK_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  `${homedir()}/.local/bin`,
  '/usr/bin',
  '/bin',
];

export function cliAuthPath(currentPath: string | undefined = process.env.PATH): string {
  const existing = currentPath ? currentPath.split(delimiter).filter(Boolean) : [];
  const seen = new Set(existing);
  const merged = [...existing];
  for (const dir of CLI_FALLBACK_PATH_DIRS) {
    if (!seen.has(dir)) {
      merged.push(dir);
      seen.add(dir);
    }
  }
  return merged.join(delimiter);
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
    env: { ...process.env, PATH: cliAuthPath() },
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
