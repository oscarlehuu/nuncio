import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const LINUX_HOST_READ_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];
const MACOS_SYSTEM_READ_ROOTS = [
  '/System/Library', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/dev',
  '/private/var/db/timezone',
];
const MACOS_TOOLCHAIN_PREFIXES = ['/opt/homebrew', '/usr/local'];
const MACOS_TOOLCHAIN_READ_SUBPATHS = ['bin', 'sbin', 'Cellar', 'lib', 'opt', 'share'];
const sandboxProbeCache = new Map<string, boolean>();

export interface CrewSandboxLaunch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  tempDir: string;
}

export interface CrewSandboxOptions {
  dependencyRoot?: string | null;
  sourceRoot?: string | null;
}

export function isCrewVerifierSandboxAvailable(
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

export function buildCrewSandboxLaunch(
  command: string,
  cwd: string,
  platform = process.platform,
  sandboxExecutable = platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap',
  options: CrewSandboxOptions = {},
): CrewSandboxLaunch {
  if (!isCrewVerifierSandboxAvailable(platform, sandboxExecutable)) {
    throw new Error('Crew verifier sandbox is unavailable; refusing unsandboxed execution');
  }
  const canonicalCwd = realpathSync.native(cwd);
  const dependencyRoot = options.dependencyRoot ? realpathSync.native(options.dependencyRoot) : null;
  const sourceRoot = options.sourceRoot ? realpathSync.native(options.sourceRoot) : null;
  if (dependencyRoot && !statSync(dependencyRoot).isDirectory()) {
    throw new Error('Crew verifier dependency root is not a directory');
  }
  if (sourceRoot && !statSync(sourceRoot).isDirectory()) {
    throw new Error('Crew verifier source root is not a directory');
  }
  if (platform === 'linux' && sourceRoot && LINUX_HOST_READ_ROOTS.some((root) =>
    existsSync(root) && (within(root, sourceRoot) || within(sourceRoot, root)))) {
    throw new Error('Crew verifier source root overlaps a Linux host bind; refusing execution');
  }
  const tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'nuncio-crew-verify-')));
  try {
    const toolBin = dirname(process.execPath);
    const macosToolchainRoots = platform === 'darwin' ? macosToolchainReadRoots(toolBin) : [];
    const pathEntries = platform === 'darwin'
      ? ['/usr/bin', '/bin', '/usr/sbin', '/sbin', ...MACOS_TOOLCHAIN_PREFIXES
          .flatMap((prefix) => ['bin', 'sbin'].map((name) => join(prefix, name)))
          .filter(existsSync), toolBin]
      : ['/nuncio-tools', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
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
    };
    if (platform === 'linux') return linuxLaunch(
      sandboxExecutable, command, canonicalCwd, tempDir, env, dependencyRoot,
    );
    const readRoots = [
      canonicalCwd, tempDir, ...macosToolchainRoots, ...(dependencyRoot ? [dependencyRoot] : []),
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
      ...(sourceRoot ? [
        `(deny file-read-data (subpath ${seatbelt(sourceRoot)}))`,
        `(deny file-write* (subpath ${seatbelt(sourceRoot)}))`,
      ] : []),
      `(deny file-write* (subpath ${seatbelt(join(canonicalCwd, '.git'))}))`,
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
  dependencyRoot: string | null,
): CrewSandboxLaunch {
  // Run the verifier command as PID 1 so bubblewrap does not leave a readable
  // helper process in the sandbox's /proc tree with pre-clearenv state.
  const argv = [
    executable, '--die-with-parent', '--unshare-all', '--new-session', '--as-pid-1', '--clearenv',
  ];
  for (const root of LINUX_HOST_READ_ROOTS) {
    if (existsSync(root)) argv.push('--ro-bind', root, root);
  }
  if (dependencyRoot) argv.push('--dir', '/nuncio-deps', '--ro-bind', dependencyRoot, '/nuncio-deps');
  argv.push(
    '--proc', '/proc', '--dev', '/dev', '--bind', cwd, '/workspace',
    '--bind', tempDir, '/tmp', '--dir', '/nuncio-tools',
    '--ro-bind', process.execPath, '/nuncio-tools/bun',
  );
  if (existsSync(join(cwd, '.git'))) argv.push('--ro-bind', join(cwd, '.git'), '/workspace/.git');
  for (const [key, value] of Object.entries({ ...env, HOME: '/tmp', TMPDIR: '/tmp' })) {
    argv.push('--setenv', key, value);
  }
  argv.push('--chdir', '/workspace', '/bin/sh', '-c', command);
  return { argv, cwd, env: {}, tempDir };
}

function seatbelt(value: string): string { return JSON.stringify(value); }
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
