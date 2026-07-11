import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';

const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const DEPENDENCY_STORES = new Set(['.bun', '.pnpm']);
const LINUX_DEPENDENCY_MOUNT = '/nuncio-deps';

export function projectCrewDependencies(input: {
  snapshotPath: string;
  sourcePath: string;
  worktrees: string[];
  platform?: NodeJS.Platform;
}): string | null {
  const packageDirs = findPackageDirectories(input.snapshotPath);
  if (!packageDirs.some(hasDependencies)) return null;
  const locks = LOCKFILES.filter((name) => existsSync(join(input.snapshotPath, name)));
  if (locks.length === 0) {
    throw new Error('Crew verification dependencies require a frozen lockfile');
  }
  const sourcePath = realpathSync.native(input.sourcePath);
  const provider = input.worktrees.map(canonicalDirectory).find((candidate) =>
    candidate !== null && candidate !== sourcePath && dependenciesMatch(input.snapshotPath, candidate, locks),
  );
  if (!provider) {
    throw new Error('Crew verification has no separately installed dependencies for the frozen lockfile');
  }
  const dependencyRoot = realpathSync.native(join(provider, 'node_modules'));
  for (const snapshotPackage of packageDirs) {
    const relativePackage = relative(input.snapshotPath, snapshotPackage);
    const installedModules = join(provider, relativePackage, 'node_modules');
    if (!isDirectory(installedModules)) continue;
    mirrorNodeModules({
      source: installedModules,
      destination: join(snapshotPackage, 'node_modules'),
      providerRoot: provider,
      snapshotRoot: input.snapshotPath,
      dependencyRoot,
      platform: input.platform ?? process.platform,
    });
  }
  return dependencyRoot;
}

function dependenciesMatch(snapshot: string, candidate: string, locks: string[]): boolean {
  if (!isDirectory(join(candidate, 'node_modules'))) return false;
  return locks.every((name) => {
    const expected = join(snapshot, name);
    const installed = join(candidate, name);
    return existsSync(installed) && readFileSync(expected).equals(readFileSync(installed));
  });
}

function findPackageDirectories(root: string): string[] {
  const packages: string[] = [];
  const visit = (path: string) => {
    if (existsSync(join(path, 'package.json'))) packages.push(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
      visit(join(path, entry.name));
    }
  };
  visit(root);
  return packages;
}

function hasDependencies(packagePath: string): boolean {
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8')); }
  catch { throw new Error(`Crew verification package manifest is invalid: ${packagePath}`); }
  return DEPENDENCY_FIELDS.some((field) => {
    const value = manifest[field];
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
  });
}

function mirrorNodeModules(input: MirrorInput): void {
  mkdirSync(input.destination, { recursive: true });
  for (const entry of readdirSync(input.source, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.bin' && !DEPENDENCY_STORES.has(entry.name)) continue;
    const source = join(input.source, entry.name);
    const destination = join(input.destination, entry.name);
    if (DEPENDENCY_STORES.has(entry.name)) {
      if (input.source !== input.dependencyRoot) {
        throw new Error('Crew verification found an unsupported nested dependency store');
      }
      symlinkDependency(source, destination, input);
    } else if (entry.isSymbolicLink()) {
      mirrorSymlink(source, destination, input);
    } else if (entry.isDirectory() && (entry.name === '.bin' || entry.name.startsWith('@'))) {
      mirrorContainer(source, destination, input);
    } else if (entry.isDirectory()) {
      symlinkDependency(source, destination, input);
    }
  }
}

function mirrorContainer(source: string, destination: string, input: MirrorInput): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const childSource = join(source, entry.name);
    const childDestination = join(destination, entry.name);
    if (entry.isSymbolicLink()) mirrorSymlink(childSource, childDestination, input);
    else if (entry.isFile()) {
      copyFileSync(childSource, childDestination);
      chmodSync(childDestination, lstatSync(childSource).mode & 0o777);
    } else if (entry.isDirectory()) symlinkDependency(childSource, childDestination, input);
  }
}

function mirrorSymlink(source: string, destination: string, input: MirrorInput): void {
  let target: string;
  try { target = realpathSync.native(source); }
  catch { throw new Error('Crew verification dependency link is dangling'); }
  if (within(input.dependencyRoot, target)) {
    symlinkSync(dependencyTarget(target, input), destination);
  } else if (within(input.providerRoot, target)) {
    const snapshotTarget = join(input.snapshotRoot, relative(input.providerRoot, target));
    if (!existsSync(snapshotTarget)) throw new Error('Crew verification workspace dependency is absent');
    symlinkSync(workspaceTarget(snapshotTarget, input), destination);
  } else throw new Error('Crew verification dependency link escapes the installed worktree');
}

function symlinkDependency(source: string, destination: string, input: MirrorInput): void {
  if (!within(input.dependencyRoot, source)) {
    throw new Error('Crew verification dependency directory is outside the read-only store');
  }
  symlinkSync(dependencyTarget(source, input), destination, 'dir');
}

function dependencyTarget(source: string, input: MirrorInput): string {
  const suffix = relative(input.dependencyRoot, source);
  return input.platform === 'linux' ? join(LINUX_DEPENDENCY_MOUNT, suffix) : source;
}

function workspaceTarget(source: string, input: MirrorInput): string {
  const suffix = relative(input.snapshotRoot, source);
  return input.platform === 'linux' ? join('/workspace', suffix) : source;
}

function canonicalDirectory(path: string): string | null {
  try { return isDirectory(path) ? realpathSync.native(path) : null; } catch { return null; }
}
function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(); } catch { return false; }
}
function within(root: string, path: string): boolean { return path === root || path.startsWith(`${root}/`); }

interface MirrorInput {
  source: string;
  destination: string;
  providerRoot: string;
  snapshotRoot: string;
  dependencyRoot: string;
  platform: NodeJS.Platform;
}

export { LINUX_DEPENDENCY_MOUNT };
