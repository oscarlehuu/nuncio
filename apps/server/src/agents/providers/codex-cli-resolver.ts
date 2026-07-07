import { accessSync, constants, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expandHome } from './cli-path.helpers';

// Re-exported so existing importers (and specs) that pull `expandHome` from this
// resolver keep working after the implementation moved to the shared helper.
export { expandHome };

export type CodexCliCommandRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export type CodexCliResolutionStatus =
  | 'ready'
  | 'not-found'
  | 'not-logged-in'
  | 'ambiguous'
  | 'invalid';

export interface CodexCliProbe {
  binaryPath: string;
  realPath: string;
  version: string | null;
  loggedIn: boolean;
  versionOk: boolean;
  loginOk: boolean;
  error: string | null;
}

export interface CodexCliResolution {
  status: CodexCliResolutionStatus;
  binaryPath?: string;
  explicit: boolean;
  reason: string;
  candidates: CodexCliProbe[];
}

interface DiscoveryInput {
  env?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  listReleaseBins?: () => string[];
}

interface ResolveInput extends DiscoveryInput {
  configuredPath?: string;
  candidatePaths?: string[];
  commandRunner: CodexCliCommandRunner;
}

const DEFAULT_CODEX_BIN = 'codex';

export function discoverCodexCliCandidates(input: DiscoveryInput = {}): string[] {
  const env = input.env ?? process.env;
  const pathExists = input.pathExists ?? executableExists;
  const realpath = input.realpath ?? safeRealpath;
  const home = env.HOME || homedir();
  const rawPaths: string[] = [];

  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    rawPaths.push(join(dir, DEFAULT_CODEX_BIN));
  }

  rawPaths.push(
    expandHome('~/.local/bin/codex', env),
    expandHome('~/.codex/packages/standalone/current/bin/codex', env),
    expandHome('~/.bun/bin/codex', env),
    expandHome('~/.local/share/bun/bin/codex', env),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  );

  const releaseBins = input.listReleaseBins ?? (() => listStandaloneReleaseBins(home));
  rawPaths.push(...releaseBins());

  return uniqueExistingCandidates(rawPaths, pathExists, realpath);
}

export async function resolveCodexCli(input: ResolveInput): Promise<CodexCliResolution> {
  const env = input.env ?? process.env;
  const configured = input.configuredPath?.trim();
  const explicit = Boolean(configured && configured !== DEFAULT_CODEX_BIN);
  const realpath = input.realpath ?? safeRealpath;

  if (explicit) {
    const binaryPath = expandHome(configured!, env);
    const candidate = await probeCli(binaryPath, realpath(binaryPath), input.commandRunner, env);
    if (candidate.versionOk && candidate.loginOk) {
      return {
        status: 'ready',
        binaryPath,
        explicit: true,
        reason: `Using configured Codex CLI at ${binaryPath}.`,
        candidates: [candidate],
      };
    }

    return {
      status: candidate.versionOk ? 'not-logged-in' : 'invalid',
      explicit: true,
      reason: candidate.versionOk
        ? `Configured Codex CLI is not logged in: ${binaryPath}. Run "${binaryPath} login".`
        : `Configured Codex CLI is not executable or did not report a version: ${binaryPath}.`,
      candidates: [candidate],
    };
  }

  const paths = uniqueByRealPath(
    input.candidatePaths ?? discoverCodexCliCandidates({ ...input, env, realpath }),
    realpath,
  );
  const candidates = await Promise.all(
    paths.map((path) => probeCli(path, realpath(path), input.commandRunner, env)),
  );
  const loggedIn = candidates.filter((candidate) => candidate.versionOk && candidate.loginOk);

  if (loggedIn.length === 1) {
    return {
      status: 'ready',
      binaryPath: loggedIn[0].binaryPath,
      explicit: false,
      reason: `Auto-selected the only logged-in Codex CLI at ${loggedIn[0].binaryPath}.`,
      candidates,
    };
  }

  if (loggedIn.length > 1) {
    return {
      status: 'ambiguous',
      explicit: false,
      reason: `Multiple logged-in Codex CLIs found. Set NUNCIO_CODEX_BIN to one absolute path: ${formatCandidates(loggedIn)}.`,
      candidates,
    };
  }

  const versionOk = candidates.filter((candidate) => candidate.versionOk);
  if (versionOk.length > 0) {
    return {
      status: 'not-logged-in',
      explicit: false,
      reason: `Codex CLI found but no discovered install is logged in. Run "codex login" or set NUNCIO_CODEX_BIN explicitly.`,
      candidates,
    };
  }

  return {
    status: 'not-found',
    explicit: false,
    reason: 'No Codex CLI install was discovered. Install Codex or set NUNCIO_CODEX_BIN to the absolute CLI path.',
    candidates,
  };
}

async function probeCli(
  binaryPath: string,
  realPath: string,
  commandRunner: CodexCliCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<CodexCliProbe> {
  try {
    const version = await commandRunner(binaryPath, ['--version'], { env });
    const versionOk = version.status === 0;
    if (!versionOk) {
      return {
        binaryPath,
        realPath,
        version: null,
        loggedIn: false,
        versionOk: false,
        loginOk: false,
        error: firstOutput(version) || 'version probe failed',
      };
    }

    const login = await commandRunner(binaryPath, ['login', 'status'], { env });
    const loginOk = login.status === 0;
    return {
      binaryPath,
      realPath,
      version: firstOutput(version),
      loggedIn: loginOk,
      versionOk,
      loginOk,
      error: loginOk ? null : firstOutput(login) || 'login status failed',
    };
  } catch (error) {
    return {
      binaryPath,
      realPath,
      version: null,
      loggedIn: false,
      versionOk: false,
      loginOk: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function uniqueExistingCandidates(
  paths: string[],
  pathExists: (path: string) => boolean,
  realpath: (path: string) => string,
): string[] {
  return uniqueByRealPath(paths.filter(pathExists), realpath);
}

function uniqueByRealPath(paths: string[], realpath: (path: string) => string): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const key = realpath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(path);
  }
  return unique;
}

function executableExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function listStandaloneReleaseBins(home: string): string[] {
  const releasesDir = join(home, '.codex/packages/standalone/releases');
  try {
    return readdirSync(releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(releasesDir, entry.name, 'bin/codex'));
  } catch {
    return [];
  }
}

function firstOutput(result: { stdout: string; stderr: string }): string | null {
  return (result.stdout.trim() || result.stderr.trim()) || null;
}

function formatCandidates(candidates: CodexCliProbe[]): string {
  return candidates
    .map((candidate) => {
      const version = candidate.version ? ` (${candidate.version})` : '';
      return `${candidate.binaryPath}${version}`;
    })
    .join(', ');
}
