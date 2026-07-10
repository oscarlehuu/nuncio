import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const LINUX_HOST_READ_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];

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
  return (platform === 'darwin' || platform === 'linux') && existsSync(executable);
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
    const path = ['/nuncio-tools', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin', toolBin]
      .filter((entry, index, all) => all.indexOf(entry) === index).join(':');
    const env = { HOME: tempDir, TMPDIR: tempDir, PATH: path, CI: '1', LANG: 'en_US.UTF-8', NO_COLOR: '1' };
    if (platform === 'linux') return linuxLaunch(
      sandboxExecutable, command, canonicalCwd, tempDir, env, dependencyRoot,
    );
    const readRoots = [canonicalCwd, tempDir, toolBin, ...(dependencyRoot ? [dependencyRoot] : [])];
    const exactReads = [...new Set(readRoots.flatMap(ancestorDirectories))];
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(deny mach-lookup)',
      '(deny appleevent-send)',
      ...['/Users', dirname(realpathSync.native(tmpdir())), '/private/tmp', '/Volumes']
        .map((root) => denyReadOutside(
          root, readRoots, exactReads.filter((path) => within(root, path)),
        )),
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

function linuxLaunch(
  executable: string, command: string, cwd: string, tempDir: string, env: Record<string, string>,
  dependencyRoot: string | null,
): CrewSandboxLaunch {
  const argv = [executable, '--die-with-parent', '--unshare-all', '--new-session', '--clearenv'];
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
