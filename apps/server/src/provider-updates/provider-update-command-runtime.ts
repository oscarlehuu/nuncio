import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export type ProviderUpdateCommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<{ status: number | null; stdout: string; stderr: string; timedOut?: boolean }>;

export const VERSION_TIMEOUT_MS = 4_000;

const MAX_OUTPUT_CHARS = 10_000;
const PROVIDER_UPDATE_FALLBACK_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  `${homedir()}/.bun/bin`,
  `${homedir()}/.local/bin`,
  '/usr/bin',
  '/bin',
];

export async function fetchNpmLatestVersion(packageName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { version?: unknown };
    return typeof payload.version === 'string' && payload.version.trim()
      ? payload.version.trim()
      : null;
  } catch {
    return null;
  }
}

export function resolveRealCommandPath(binaryPath: string): string | null {
  const candidates =
    binaryPath.includes('/') || binaryPath.includes('\\')
      ? [binaryPath]
      : providerUpdatePath(process.env.PATH)
          .split(delimiter)
          .map((entry) => join(entry, binaryPath));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return realpathSync(candidate);
    } catch {
      return candidate;
    }
  }
  return null;
}

export function providerUpdatePath(currentPath: string | undefined = process.env.PATH): string {
  const existing = currentPath ? currentPath.split(delimiter).filter(Boolean) : [];
  const seen = new Set(existing);
  const merged = [...existing];
  for (const dir of PROVIDER_UPDATE_FALLBACK_PATH_DIRS) {
    if (seen.has(dir)) continue;
    merged.push(dir);
    seen.add(dir);
  }
  return merged.join(delimiter);
}

export function providerUpdateEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: providerUpdatePath(env.PATH) };
}

export function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut?: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: providerUpdateEnv(options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, options.timeoutMs)
        : null;
    child.stdout?.on('data', (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on('error', reject);
    child.on('close', (status) => {
      if (timeout) clearTimeout(timeout);
      resolve({ status, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
    });
  });
}

function appendOutput(current: string, chunk: Buffer): string {
  return (current + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
}
