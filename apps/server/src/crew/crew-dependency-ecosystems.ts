import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { CrewDependencyMount } from './crew-command-sandbox';
import { projectCrewDependencies } from './crew-dependency-projection';

// Fixed Linux guest mounts for content-addressed caches that are referenced only through an env var
// (never a shebang), distinct from the JS store at /nuncio-deps. Toolchain directories and
// virtualenvs are instead bound at their ORIGINAL host path so console-script shebangs and PATH
// entries resolve; Seatbelt cannot remap paths, so macOS reads the host path directly either way.
const GUEST_GO_MODCACHE = '/nuncio-go-mod';
const GUEST_CARGO_HOME = '/nuncio-cargo';
const PYTHON_LOCKS = ['poetry.lock', 'uv.lock'];

type WhichFn = (bin: string) => string | null;

interface CrewDependencyStrategyInput {
  snapshotPath: string;
  sourcePath: string;
  worktrees: string[];
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  which: WhichFn;
}

// A dependency projection keyed by detected ecosystem. `detect` reads only the disposable snapshot's
// lockfile markers; `project` locates trusted-host caches and returns read-only mounts, or an empty
// list when the toolchain or a cache is absent/unmatched (unchanged, uncached behavior — never a
// throw and never unproven gate evidence).
interface CrewDependencyStrategy {
  readonly ecosystem: string;
  detect(snapshotPath: string): boolean;
  project(input: CrewDependencyStrategyInput): CrewDependencyMount[];
}

const goStrategy: CrewDependencyStrategy = {
  ecosystem: 'go',
  detect: (snapshot) => existsSync(join(snapshot, 'go.sum')),
  project: (input) => {
    const toolchain = toolchainMount(input, 'go');
    if (!toolchain) return [];
    const cache = canonicalCacheDir(goModCacheDir(input.env, input.homeDir));
    if (!cache) return [];
    // `-mod=readonly` keeps `go build` from writing into the read-only module cache; the build cache
    // (GOCACHE) defaults under the writable sandbox HOME/XDG_CACHE_HOME.
    return [
      {
        hostPath: cache, guestPath: GUEST_GO_MODCACHE, pathPrepend: [],
        env: {
          GOMODCACHE: input.platform === 'linux' ? GUEST_GO_MODCACHE : cache,
          GOFLAGS: '-mod=readonly', GOPROXY: 'off', GOTOOLCHAIN: 'local',
        },
      },
      toolchain,
    ];
  },
};

const rustStrategy: CrewDependencyStrategy = {
  ecosystem: 'rust',
  detect: (snapshot) => existsSync(join(snapshot, 'Cargo.lock')),
  project: (input) => {
    const toolchain = toolchainMount(input, 'cargo');
    if (!toolchain) return [];
    const cargoHome = input.env.CARGO_HOME || join(input.homeDir, '.cargo');
    const registry = canonicalCacheDir(join(cargoHome, 'registry'));
    if (!registry) return [];
    // A Cargo.lock with git dependencies cannot resolve offline without $CARGO_HOME/git; do not
    // claim a projection we cannot honor for that shape.
    const gitNeeded = cargoLockHasGitSource(join(input.snapshotPath, 'Cargo.lock'));
    const git = gitNeeded ? canonicalCacheDir(join(cargoHome, 'git')) : null;
    if (gitNeeded && !git) return [];
    // Mount the registry (and git) read-only inside a writable CARGO_HOME so cargo can take its
    // package-cache lock while the crate caches cannot be mutated.
    const home = input.platform === 'linux' ? GUEST_CARGO_HOME : (canonicalPath(cargoHome) ?? cargoHome);
    const mounts: CrewDependencyMount[] = [{
      hostPath: registry, guestPath: `${GUEST_CARGO_HOME}/registry`, writableGuestParent: GUEST_CARGO_HOME,
      pathPrepend: [], env: { CARGO_HOME: home, CARGO_NET_OFFLINE: 'true' },
    }];
    if (git) mounts.push({ hostPath: git, guestPath: `${GUEST_CARGO_HOME}/git`, pathPrepend: [], env: {} });
    mounts.push(toolchain);
    return mounts;
  },
};

const pythonStrategy: CrewDependencyStrategy = {
  ecosystem: 'python',
  detect: (snapshot) => PYTHON_LOCKS.some((lock) => existsSync(join(snapshot, lock))),
  project: (input) => {
    const venv = matchedVenv(input);
    if (!venv) return [];
    // Bind at the original path so venv console-script shebangs (pytest/ruff/mypy, which embed the
    // interpreter's absolute path) resolve inside the sandbox.
    return [{
      hostPath: venv, guestPath: venv, pathPrepend: [join(venv, 'bin')],
      env: { VIRTUAL_ENV: venv, PYTHONDONTWRITEBYTECODE: '1' },
    }];
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
  which?: WhichFn;
}): { dependencyRoot: string | null; mounts: CrewDependencyMount[] } {
  const platform = input.platform ?? process.platform;
  const worktrees = input.worktrees ?? [];
  const dependencyRoot = projectCrewDependencies({
    snapshotPath: input.snapshotPath, sourcePath: input.sourcePath, worktrees, platform,
  });
  const strategyInput: CrewDependencyStrategyInput = {
    snapshotPath: input.snapshotPath, sourcePath: input.sourcePath, worktrees, platform,
    env: input.env ?? process.env, homeDir: input.homeDir ?? homedir(),
    which: input.which ?? ((bin) => Bun.which(bin)),
  };
  const mounts: CrewDependencyMount[] = [];
  for (const strategy of ECOSYSTEM_STRATEGIES) {
    if (!strategy.detect(input.snapshotPath)) continue;
    mounts.push(...strategy.project(strategyInput));
  }
  return { dependencyRoot, mounts };
}

// Resolves a toolchain binary and returns a read-only mount of its install root (kept at its real
// path so its own PATH/GOROOT resolution works), or null when the toolchain is missing or installed
// under the user's home. A home-installed toolchain (rustup `~/.cargo/bin`, mise/asdf) is not
// reachable in the home-denied sandbox, so we do not advertise a projection that would fail with a
// cleared PATH — the container backend is the path for those.
function toolchainMount(input: CrewDependencyStrategyInput, bin: string): CrewDependencyMount | null {
  const real = canonicalPath(input.which(bin) ?? undefined);
  const home = canonicalPath(input.homeDir) ?? input.homeDir;
  if (!real || within(home, real)) return null;
  const binDir = dirname(real);
  const root = dirname(binDir);
  return { hostPath: root, guestPath: root, pathPrepend: [binDir], env: {} };
}

// Only borrow a virtualenv proven to belong to the frozen lockfile: mirror the JS byte-equal check
// so an ambient $VIRTUAL_ENV or a sibling-worktree `.venv` installed for a different lock can never
// become gate evidence. The venv must live in a worktree whose python lockfile bytes match the
// snapshot exactly.
function matchedVenv(input: CrewDependencyStrategyInput): string | null {
  const locks = PYTHON_LOCKS.filter((lock) => existsSync(join(input.snapshotPath, lock)));
  if (!locks.length) return null;
  for (const worktree of [input.sourcePath, ...input.worktrees]) {
    const venv = canonicalCacheDir(join(worktree, '.venv'));
    if (!venv || !existsSync(join(venv, 'bin'))) continue;
    if (locks.every((lock) => filesEqual(join(input.snapshotPath, lock), join(worktree, lock)))) return venv;
  }
  return null;
}

function goModCacheDir(env: NodeJS.ProcessEnv, home: string): string {
  if (env.GOMODCACHE) return env.GOMODCACHE;
  const gopath = env.GOPATH?.split(delimiter).find(Boolean) || join(home, 'go');
  return join(gopath, 'pkg', 'mod');
}

function cargoLockHasGitSource(cargoLockPath: string): boolean {
  try { return /\bsource\s*=\s*"git\+/.test(readFileSync(cargoLockPath, 'utf8')); }
  catch { return false; }
}

function filesEqual(a: string, b: string): boolean {
  try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}

// Resolves a cache path to its canonical directory, or null when absent, a file, or a dangling link.
// Returning null is the documented fallback: no projection, unchanged uncached behavior.
function canonicalCacheDir(path: string | undefined): string | null {
  const real = canonicalPath(path);
  if (!real) return null;
  try { return lstatSync(real).isDirectory() ? real : null; } catch { return null; }
}

function canonicalPath(path: string | undefined): string | null {
  if (!path) return null;
  try { return realpathSync.native(path); } catch { return null; }
}

function within(root: string, path: string): boolean { return path === root || path.startsWith(`${root}/`); }
