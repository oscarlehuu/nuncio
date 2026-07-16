import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { CrewDependencyMount } from './crew-command-sandbox';
import { projectCrewDependencies } from './crew-dependency-projection';

// Fixed Linux guest mount points, distinct from the JS store at `/nuncio-deps` so multiple
// ecosystems can be projected side by side without collision. macOS reads the host cache path
// directly (Seatbelt allows/denies but does not remap), so these constants are Linux-only.
const GUEST_GO_MODCACHE = '/nuncio-go-mod';
const GUEST_CARGO_HOME = '/nuncio-cargo';
const GUEST_PYTHON_VENV = '/nuncio-venv';

interface CrewDependencyStrategyInput {
  snapshotPath: string;
  sourcePath: string;
  worktrees: string[];
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

// A dependency projection keyed by detected ecosystem. `detect` reads only the disposable snapshot's
// lockfile markers; `project` locates the trusted-host cache and returns a read-only mount, or null
// when the cache is absent (unchanged, uncached behavior — never a throw).
interface CrewDependencyStrategy {
  readonly ecosystem: string;
  detect(snapshotPath: string): boolean;
  project(input: CrewDependencyStrategyInput): CrewDependencyMount | null;
}

const goStrategy: CrewDependencyStrategy = {
  ecosystem: 'go',
  detect: (snapshot) => existsSync(join(snapshot, 'go.sum')),
  project: (input) => {
    const host = canonicalCacheDir(goModCacheDir(input.env, input.homeDir));
    if (!host) return null;
    // `-mod=readonly` keeps `go build` from writing into the read-only module cache; the build cache
    // (GOCACHE) defaults under the writable sandbox HOME/XDG_CACHE_HOME.
    return {
      hostPath: host,
      guestPath: GUEST_GO_MODCACHE,
      env: {
        GOMODCACHE: input.platform === 'linux' ? GUEST_GO_MODCACHE : host,
        GOFLAGS: '-mod=readonly', GOPROXY: 'off', GOTOOLCHAIN: 'local',
      },
      pathPrepend: [],
    };
  },
};

const rustStrategy: CrewDependencyStrategy = {
  ecosystem: 'rust',
  detect: (snapshot) => existsSync(join(snapshot, 'Cargo.lock')),
  project: (input) => {
    const cargoHome = input.env.CARGO_HOME || join(input.homeDir, '.cargo');
    const registry = canonicalCacheDir(join(cargoHome, 'registry'));
    if (!registry) return null;
    // Mount only the registry read-only; CARGO_HOME stays a writable dir (a tmpfs `--dir` on Linux)
    // so cargo can take its package-cache lock while the crate registry cannot be mutated.
    return {
      hostPath: registry,
      guestPath: `${GUEST_CARGO_HOME}/registry`,
      writableGuestParent: GUEST_CARGO_HOME,
      env: {
        CARGO_HOME: input.platform === 'linux' ? GUEST_CARGO_HOME : canonicalDir(cargoHome) ?? cargoHome,
        CARGO_NET_OFFLINE: 'true',
      },
      pathPrepend: [],
    };
  },
};

const pythonStrategy: CrewDependencyStrategy = {
  ecosystem: 'python',
  detect: (snapshot) =>
    existsSync(join(snapshot, 'poetry.lock')) || existsSync(join(snapshot, 'uv.lock')),
  project: (input) => {
    const venv = pythonVenvDir(input);
    if (!venv) return null;
    const value = input.platform === 'linux' ? GUEST_PYTHON_VENV : venv;
    return {
      hostPath: venv,
      guestPath: GUEST_PYTHON_VENV,
      env: { VIRTUAL_ENV: value, PYTHONDONTWRITEBYTECODE: '1' },
      pathPrepend: [`${value}/bin`],
    };
  },
};

const ECOSYSTEM_STRATEGIES: CrewDependencyStrategy[] = [goStrategy, rustStrategy, pythonStrategy];

// Runs the JS store projection plus every detected non-JS ecosystem strategy. JS keeps its existing
// single `dependencyRoot` contract (mounted at `/nuncio-deps` with in-snapshot symlink mirroring);
// the extra ecosystems are additive read-only mounts. Unknown ecosystems yield no mounts.
export function projectCrewEcosystemDependencies(input: {
  snapshotPath: string;
  sourcePath: string;
  worktrees?: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): { dependencyRoot: string | null; mounts: CrewDependencyMount[] } {
  const platform = input.platform ?? process.platform;
  const worktrees = input.worktrees ?? [];
  const dependencyRoot = projectCrewDependencies({
    snapshotPath: input.snapshotPath, sourcePath: input.sourcePath, worktrees, platform,
  });
  const strategyInput: CrewDependencyStrategyInput = {
    snapshotPath: input.snapshotPath, sourcePath: input.sourcePath, worktrees,
    platform, env: input.env ?? process.env, homeDir: input.homeDir ?? homedir(),
  };
  const mounts: CrewDependencyMount[] = [];
  for (const strategy of ECOSYSTEM_STRATEGIES) {
    if (!strategy.detect(input.snapshotPath)) continue;
    const mount = strategy.project(strategyInput);
    if (mount) mounts.push(mount);
  }
  return { dependencyRoot, mounts };
}

function goModCacheDir(env: NodeJS.ProcessEnv, home: string): string {
  if (env.GOMODCACHE) return env.GOMODCACHE;
  const gopath = env.GOPATH?.split(delimiter).find(Boolean) || join(home, 'go');
  return join(gopath, 'pkg', 'mod');
}

function pythonVenvDir(input: CrewDependencyStrategyInput): string | null {
  const candidates = [
    input.env.VIRTUAL_ENV,
    ...[input.sourcePath, ...input.worktrees].map((worktree) => join(worktree, '.venv')),
  ];
  for (const candidate of candidates) {
    const dir = canonicalCacheDir(candidate);
    // A real virtualenv has an executable `bin/` (POSIX layout); require it so a bare `.venv`
    // directory is not mistaken for an installed environment.
    if (dir && existsSync(join(dir, 'bin'))) return dir;
  }
  return null;
}

// Resolves a cache path to its canonical directory, or null when absent, a file, or a dangling
// link. Returning null is the documented fallback: no projection, unchanged uncached behavior.
function canonicalCacheDir(path: string | undefined): string | null {
  const real = canonicalDir(path);
  if (!real) return null;
  try { return lstatSync(real).isDirectory() ? real : null; } catch { return null; }
}

function canonicalDir(path: string | undefined): string | null {
  if (!path) return null;
  try { return realpathSync.native(path); } catch { return null; }
}
