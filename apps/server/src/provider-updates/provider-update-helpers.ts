import type { ProviderToolId } from './provider-updates.types';

export type InstallMethod = 'npm' | 'bun' | 'pnpm' | 'homebrew' | 'standalone' | 'unknown';

export interface UpdateAction {
  command: string;
  executable: string;
  args: string[];
}

export interface UpdateTarget {
  canUpdate: boolean;
  updateCommand: string | null;
  action?: UpdateAction;
}

export interface ProviderToolUpdateDefinition {
  provider: ProviderToolId;
  packageName: string;
  nativeUpdateArgs?: string[];
  standalonePathMarkers?: string[];
  homebrewName?: string;
  homebrewKind?: 'formula' | 'cask';
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const VERSION_PATTERN = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

export function settingEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

export function parseCliVersion(output: string): string | null {
  const match = output.match(VERSION_PATTERN);
  return match?.[1] ? normalizeVersion(match[1]) : null;
}

export function compareVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) return left.localeCompare(right);

  if (parsedLeft.major !== parsedRight.major) return parsedLeft.major - parsedRight.major;
  if (parsedLeft.minor !== parsedRight.minor) return parsedLeft.minor - parsedRight.minor;
  if (parsedLeft.patch !== parsedRight.patch) return parsedLeft.patch - parsedRight.patch;
  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) return 0;
  if (parsedLeft.prerelease.length === 0) return 1;
  if (parsedRight.prerelease.length === 0) return -1;

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const compared = comparePrereleasePart(leftPart, rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(' ');
}

export function buildUpdateTarget(
  definition: ProviderToolUpdateDefinition,
  binaryPath: string,
  realCommandPath: string | null,
): UpdateTarget {
  const installMethod = detectInstallMethod(realCommandPath ?? binaryPath, definition);
  const packageSpec = `${definition.packageName}@latest`;
  const packageManagerTarget = packageManagerUpdateTarget(installMethod, packageSpec);
  if (packageManagerTarget) return packageManagerTarget;
  if (installMethod === 'homebrew') return homebrewUpdateTarget(definition);
  if (definition.nativeUpdateArgs) {
    const action = makeAction(binaryPath, definition.nativeUpdateArgs);
    return { canUpdate: true, updateCommand: action.command, action };
  }
  return {
    canUpdate: false,
    updateCommand: `Install ${packageSpec} manually.`,
  };
}

function normalizeVersion(version: string): string {
  const [main = '', prerelease] = version.trim().replace(/^v/, '').split('-', 2);
  const segments = main.split('.').filter(Boolean);
  if (segments.length === 2) segments.push('0');
  return prerelease ? `${segments.join('.')}-${prerelease}` : segments.join('.');
}

function parseSemver(version: string): Semver | null {
  const [main = '', prerelease] = normalizeVersion(version).split('-', 2);
  const parts = main.split('.');
  if (parts.length !== 3) return null;
  const [major, minor, patch] = parts.map((part) => Number.parseInt(part, 10));
  if (![major, minor, patch].every(Number.isInteger)) return null;
  return {
    major,
    minor,
    patch,
    prerelease: prerelease?.split('.').filter(Boolean) ?? [],
  };
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  if (leftNumber) return -1;
  if (rightNumber) return 1;
  return left.localeCompare(right);
}

function makeAction(executable: string, args: string[]): UpdateAction {
  return { command: shellJoin([executable, ...args]), executable, args };
}

function packageManagerUpdateTarget(
  installMethod: InstallMethod,
  packageSpec: string,
): UpdateTarget | null {
  if (installMethod === 'npm') return target('npm', ['install', '-g', packageSpec]);
  if (installMethod === 'bun') return target('bun', ['i', '-g', packageSpec]);
  if (installMethod === 'pnpm') return target('pnpm', ['add', '-g', packageSpec]);
  return null;
}

function homebrewUpdateTarget(definition: ProviderToolUpdateDefinition): UpdateTarget {
  const args = ['upgrade'];
  if (definition.homebrewKind === 'cask') args.push('--cask');
  args.push(definition.homebrewName ?? definition.provider);
  return target('brew', args);
}

function target(executable: string, args: string[]): UpdateTarget {
  const action = makeAction(executable, args);
  return { canUpdate: true, updateCommand: action.command, action };
}

export function detectInstallMethod(
  commandPath: string,
  definition: ProviderToolUpdateDefinition,
): InstallMethod {
  const normalized = commandPath.replaceAll('\\', '/').toLowerCase();
  if (definition.standalonePathMarkers?.some((marker) => normalized.includes(marker.toLowerCase()))) {
    return 'standalone';
  }
  if (normalized.includes('/.bun/bin/')) return 'bun';
  if (
    normalized.includes('/.local/share/pnpm/') ||
    normalized.includes('/library/pnpm/') ||
    normalized.includes('/pnpm/global/')
  ) {
    return 'pnpm';
  }
  if (
    normalized.includes('/node_modules/.bin/') ||
    normalized.includes('/lib/node_modules/') ||
    normalized.includes('/npm/node_modules/')
  ) {
    return 'npm';
  }
  if (
    normalized.startsWith('/opt/homebrew/bin/') ||
    normalized.startsWith('/usr/local/bin/') ||
    normalized.includes('/opt/homebrew/caskroom/') ||
    normalized.includes('/usr/local/caskroom/') ||
    normalized.includes('/opt/homebrew/cellar/') ||
    normalized.includes('/usr/local/cellar/')
  ) {
    return 'homebrew';
  }
  return 'unknown';
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
