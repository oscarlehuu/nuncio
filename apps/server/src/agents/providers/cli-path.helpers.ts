import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expand a leading `~` to the home directory. `~` alone maps to home; a `~/`
 * prefix joins the remainder onto home; any other path passes through unchanged.
 * The env is injectable so callers can resolve against a run-scoped HOME rather
 * than always the process's; it falls back to the OS home when HOME is unset.
 */
export function expandHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path === '~') return env.HOME || homedir();
  if (path.startsWith('~/')) return join(env.HOME || homedir(), path.slice(2));
  return path;
}
