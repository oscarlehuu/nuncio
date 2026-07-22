import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Generic OS-sandboxed command launch builder (Seatbelt on macOS, bubblewrap on
 * Linux). This is the shared confinement core consumed directly by the Pi
 * policy shell tool for hermetic runtime-policy sessions.
 * The contract is deny-network + writes confined to the working directory (+
 * a private temp dir), with `.git` and any `extraWriteDenySubpaths` read-only.
 */

const LINUX_HOST_READ_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];
const MACOS_SYSTEM_READ_ROOTS = [
  '/System/Library', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/dev',
  '/private/var/db/timezone',
];
const MACOS_TOOLCHAIN_PREFIXES = ['/opt/homebrew', '/usr/local'];
const MACOS_TOOLCHAIN_READ_SUBPATHS = ['bin', 'sbin', 'Cellar', 'lib', 'opt', 'share'];
const sandboxProbeCache = new Map<string, boolean>();

export interface RuntimeSandboxLaunch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  tempDir: string;
  // Optional best-effort teardown for confinement that owns a resource the spawned argv does not
  // (e.g. a container whose lifetime is managed by a daemon, not by the launched client process).
  // The runner invokes this once in its cleanup path; the host backend leaves it undefined because
  // killing its process group already stops everything. Must not throw and must not block.
  onTerminate?(): void;
}

// A read-only per-ecosystem dependency cache projected into the sandbox. It carries the same
// deny-by-default contract as the JS store: the toolchain's cache is readable but never writable
// inside the sandbox. Seatbelt cannot remap paths, so on macOS the toolchain reads `hostPath`
// directly; on Linux the cache is bind-mounted read-only at `guestPath`. `env` and `pathPrepend`
// are resolved for the target platform by the projection (guest paths on Linux, host paths on
// macOS) and point the toolchain at the projected cache.
interface RuntimeDependencyMount {
  hostPath: string;
  guestPath: string;
  env: Record<string, string>;
  pathPrepend: string[];
  // Linux only: a writable tmpfs directory to create before binding `hostPath` read-only inside it,
  // so a toolchain that writes metadata beside a read-only cache subdirectory keeps working (for
  // example cargo's writable CARGO_HOME containing a read-only registry). Ignored on macOS, where
  // paths are not remapped.
  writableGuestParent?: string;
}

export interface RuntimeSandboxOptions {
  dependencyRoot?: string | null;
  // Additional per-ecosystem read-only caches (Python venv, Go module cache, Cargo registry) to
  // project alongside the JS store. Empty/absent leaves behavior unchanged.
  dependencyMounts?: RuntimeDependencyMount[];
  sourceRoot?: string | null;
  // Workspace-relative subpaths (e.g. '.nuncio') to deny writes into even though they live inside
  // the writable working directory. macOS denies the subpath unconditionally; Linux read-only
  // binds the path when it exists (bubblewrap cannot deny a nonexistent path).
  extraWriteDenySubpaths?: string[];
  // Prefix for the private per-launch temp dir (HOME/TMPDIR inside the sandbox).
  tempDirPrefix?: string;
}

export function isRuntimeCommandSandboxAvailable(
  platform = process.platform,
  executable = platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap',
): boolean {
  if ((platform !== 'darwin' && platform !== 'linux') || !existsSync(executable)) return false;
  const key = `${platform}:${executable}`;
  const cached = sandboxProbeCache.get(key);
  if (cached !== undefined) return cached;
  const available = probeSandbox(platform, executable);
  sandboxProbeCache.set(key, available);
  return available;
}

export function buildRuntimeCommandSandboxLaunch(
  command: string,
  cwd: string,
  platform = process.platform,
  sandboxExecutable = platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap',
  options: RuntimeSandboxOptions = {},
): RuntimeSandboxLaunch {
  if (!isRuntimeCommandSandboxAvailable(platform, sandboxExecutable)) {
    throw new Error('Command sandbox is unavailable; refusing unsandboxed execution');
  }
  const canonicalCwd = realpathSync.native(cwd);
  const dependencyRoot = options.dependencyRoot ? realpathSync.native(options.dependencyRoot) : null;
  const dependencyMounts = normalizeDependencyMounts(options.dependencyMounts);
  const sourceRoot = options.sourceRoot ? realpathSync.native(options.sourceRoot) : null;
  const extraWriteDenyPaths = (options.extraWriteDenySubpaths ?? [])
    .map((subpath) => join(canonicalCwd, subpath));
  if (dependencyRoot && !statSync(dependencyRoot).isDirectory()) {
    throw new Error('Sandbox dependency root is not a directory');
  }
  if (sourceRoot && !statSync(sourceRoot).isDirectory()) {
    throw new Error('Sandbox source root is not a directory');
  }
  if (platform === 'linux' && sourceRoot && LINUX_HOST_READ_ROOTS.some((root) =>
    existsSync(root) && (within(root, sourceRoot) || within(sourceRoot, root)))) {
    throw new Error('Sandbox source root overlaps a Linux host bind; refusing execution');
  }
  const tempDir = realpathSync.native(
    mkdtempSync(join(tmpdir(), options.tempDirPrefix ?? 'nuncio-sandbox-')),
  );
  try {
    const toolBin = dirname(process.execPath);
    const macosToolchainRoots = platform === 'darwin' ? macosToolchainReadRoots(toolBin) : [];
    const mountPathPrepend = dependencyMounts.flatMap((mount) => mount.pathPrepend);
    const mountEnv = Object.assign({}, ...dependencyMounts.map((mount) => mount.env));
    const pathEntries = platform === 'darwin'
      ? [...mountPathPrepend, '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...MACOS_TOOLCHAIN_PREFIXES
          .flatMap((prefix) => ['bin', 'sbin'].map((name) => join(prefix, name)))
          .filter(existsSync), toolBin]
      : [...mountPathPrepend, '/nuncio-tools', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const path = pathEntries
      .filter((entry, index, all) => all.indexOf(entry) === index).join(':');
    const env = {
      HOME: tempDir,
      TMPDIR: tempDir,
      XDG_CACHE_HOME: join(tempDir, '.cache'),
      BUN_INSTALL_CACHE_DIR: join(tempDir, 'bun-install-cache'),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(tempDir, 'bun-runtime-cache'),
      PATH: path,
      CI: '1',
      LANG: 'en_US.UTF-8',
      NO_COLOR: '1',
      ...mountEnv,
    };
    if (platform === 'linux') return linuxLaunch(
      sandboxExecutable, command, canonicalCwd, tempDir, env, dependencyRoot, dependencyMounts,
      extraWriteDenyPaths,
    );
    const readRoots = [
      canonicalCwd, tempDir, ...macosToolchainRoots, ...(dependencyRoot ? [dependencyRoot] : []),
      ...dependencyMounts.map((mount) => mount.hostPath),
      ...MACOS_SYSTEM_READ_ROOTS.filter(existsSync),
    ];
    // Seatbelt evaluates directory traversal of the filesystem root as
    // file-read-data. Keep only the root node readable; descendants still pass
    // through the explicit subpath allowlist below.
    const exactReads = [...new Set(['/', ...readRoots.flatMap(ancestorDirectories)])];
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(deny mach-lookup)',
      '(deny appleevent-send)',
      denyReadOutside('/', readRoots, exactReads),
      `(deny file-write* (require-all (require-not (subpath ${seatbelt(canonicalCwd)}))`,
      `  (require-not (subpath ${seatbelt(tempDir)})) (require-not (literal "/dev/null"))))`,
      ...(dependencyRoot ? [`(deny file-write* (subpath ${seatbelt(dependencyRoot)}))`] : []),
      ...dependencyMounts.map((mount) => `(deny file-write* (subpath ${seatbelt(mount.hostPath)}))`),
      ...(sourceRoot ? [
        // A dependency cache projected from inside the source worktree (e.g. its own .venv) must
        // stay readable: carve it out of the source-root read-deny, which Seatbelt would otherwise
        // apply as the later, winning rule and nullify the earlier read-allow.
        denySourceRead(sourceRoot, dependencyMounts
          .map((mount) => mount.hostPath).filter((path) => within(sourceRoot, path))),
        `(deny file-write* (subpath ${seatbelt(sourceRoot)}))`,
      ] : []),
      `(deny file-write* (subpath ${seatbelt(join(canonicalCwd, '.git'))}))`,
      ...extraWriteDenyPaths.map((path) => `(deny file-write* (subpath ${seatbelt(path)}))`),
    ].join('\n');
    return {
      argv: [sandboxExecutable, '-p', profile, '/bin/sh', '-c', command],
      cwd: canonicalCwd,
      env,
      tempDir,
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function probeSandbox(platform: string, executable: string): boolean {
  const argv = platform === 'darwin'
    ? ['-p', '(version 1)\n(allow default)\n(deny network*)', '/usr/bin/true']
    : [
        '--die-with-parent', '--unshare-all', '--new-session',
        '--ro-bind', '/', '/', '/usr/bin/true',
      ];
  try {
    return spawnSync(executable, argv, {
      env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore', timeout: 3000,
    }).status === 0;
  } catch {
    return false;
  }
}

function linuxLaunch(
  executable: string, command: string, cwd: string, tempDir: string, env: Record<string, string>,
  dependencyRoot: string | null, dependencyMounts: RuntimeDependencyMount[],
  extraWriteDenyPaths: string[],
): RuntimeSandboxLaunch {
  // Run the confined command as PID 1 so bubblewrap does not leave a readable
  // helper process in the sandbox's /proc tree with pre-clearenv state.
  const argv = [
    executable, '--die-with-parent', '--unshare-all', '--new-session', '--as-pid-1', '--clearenv',
  ];
  for (const root of LINUX_HOST_READ_ROOTS) {
    if (existsSync(root)) argv.push('--ro-bind', root, root);
  }
  if (dependencyRoot) argv.push('--dir', '/nuncio-deps', '--ro-bind', dependencyRoot, '/nuncio-deps');
  for (const mount of dependencyMounts) {
    // A remapped guest path (guestPath !== hostPath) needs its mount point — or a writable tmpfs
    // parent that lets a toolchain write metadata beside a read-only cache subdirectory — created on
    // the tmpfs root first. An original-path bind (guestPath === hostPath, kept so venv/toolchain
    // shebangs and PATH resolve) already exists via another bind or is auto-created with the bind,
    // and its parent may be read-only, so it must not be `--dir`-ed. The cache is always read-only.
    if (mount.guestPath !== mount.hostPath) argv.push('--dir', mount.writableGuestParent ?? mount.guestPath);
    argv.push('--ro-bind', mount.hostPath, mount.guestPath);
  }
  argv.push(
    '--proc', '/proc', '--dev', '/dev', '--bind', cwd, '/workspace',
    '--bind', tempDir, '/tmp', '--dir', '/nuncio-tools',
    '--ro-bind', process.execPath, '/nuncio-tools/bun',
  );
  if (existsSync(join(cwd, '.git'))) argv.push('--ro-bind', join(cwd, '.git'), '/workspace/.git');
  for (const denyPath of extraWriteDenyPaths) {
    // bubblewrap can only pin an existing path read-only; a nonexistent gate dir keeps its
    // protection from the tool_call guard layer instead.
    if (!existsSync(denyPath)) continue;
    argv.push('--ro-bind', denyPath, join('/workspace', relativeToCwd(cwd, denyPath)));
  }
  for (const [key, value] of Object.entries({ ...env, HOME: '/tmp', TMPDIR: '/tmp' })) {
    argv.push('--setenv', key, value);
  }
  argv.push('--chdir', '/workspace', '/bin/sh', '-c', command);
  return { argv, cwd, env: {}, tempDir };
}

function relativeToCwd(cwd: string, path: string): string {
  return path === cwd ? '' : path.slice(cwd.length + 1);
}

function normalizeDependencyMounts(mounts?: RuntimeDependencyMount[]): RuntimeDependencyMount[] {
  if (!mounts?.length) return [];
  return mounts.map((mount) => {
    // The projection already realpath-canonicalizes; re-resolving here makes the sandbox the trust
    // boundary for its own bind/deny rules and fails closed on a mount that vanished after
    // projection rather than binding a stale path.
    const hostPath = realpathSync.native(mount.hostPath);
    if (!statSync(hostPath).isDirectory()) {
      throw new Error('Sandbox dependency mount is not a directory');
    }
    return { ...mount, hostPath };
  });
}

function seatbelt(value: string): string { return JSON.stringify(value); }
// Deny reads of the original source worktree, but carve out any dependency cache mounted from inside
// it so the read-allow above is not overridden by this later (winning) rule. With no carve-outs this
// is byte-identical to the prior plain subpath deny.
function denySourceRead(sourceRoot: string, carveOuts: string[]): string {
  if (!carveOuts.length) return `(deny file-read-data (subpath ${seatbelt(sourceRoot)}))`;
  return `(deny file-read-data (require-all (subpath ${seatbelt(sourceRoot)}) ${carveOuts
    .map((path) => `(require-not (subpath ${seatbelt(path)}))`).join(' ')}))`;
}
function denyReadOutside(root: string, exceptions: string[], exactExceptions: string[]): string {
  return `(deny file-read-data (require-all (subpath ${seatbelt(root)}) ${exceptions
    .map((path) => `(require-not (subpath ${seatbelt(path)}))`).join(' ')} ${exactExceptions
    .map((path) => `(require-not (literal ${seatbelt(path)}))`).join(' ')}))`;
}
function within(root: string, path: string): boolean { return path === root || path.startsWith(`${root}/`); }
function ancestorDirectories(path: string): string[] {
  const ancestors: string[] = [];
  for (let current = dirname(path); current !== dirname(current); current = dirname(current)) ancestors.push(current);
  return ancestors;
}

function macosToolchainReadRoots(toolBin: string): string[] {
  const candidates = [toolBin, ...MACOS_TOOLCHAIN_PREFIXES.flatMap((prefix) =>
    MACOS_TOOLCHAIN_READ_SUBPATHS.map((name) => join(prefix, name)),
  )];
  return candidates.filter(existsSync).map((path) => realpathSync.native(path))
    .filter((path, index, all) => all.indexOf(path) === index);
}
