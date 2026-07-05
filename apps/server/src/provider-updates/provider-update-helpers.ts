import { dirname } from 'node:path';
import type { ProviderToolId } from './provider-updates.types';

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
  provider: ProviderToolId,
  binaryPath: string,
  realCommandPath: string | null,
): UpdateTarget {
  if (provider === 'pi') {
    const action = makeAction(binaryPath, ['update']);
    return { canUpdate: true, updateCommand: action.command, action };
  }
  return buildCodexUpdateTarget(binaryPath, realCommandPath);
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

function buildCodexUpdateTarget(binaryPath: string, realCommandPath: string | null): UpdateTarget {
  const installSource = detectInstallSource(realCommandPath ?? binaryPath);
  if (installSource === 'npm') {
    const action = makeAction('npm', ['install', '-g', '@openai/codex@latest']);
    return { canUpdate: true, updateCommand: action.command, action };
  }
  if (installSource === 'bun') {
    const action = makeAction('bun', ['i', '-g', '@openai/codex@latest']);
    return { canUpdate: true, updateCommand: action.command, action };
  }
  if (installSource === 'pnpm') {
    const action = makeAction('pnpm', ['add', '-g', '@openai/codex@latest']);
    return { canUpdate: true, updateCommand: action.command, action };
  }
  if (installSource === 'homebrew') {
    const action = makeAction('brew', ['upgrade', '--cask', 'codex']);
    return { canUpdate: true, updateCommand: action.command, action };
  }
  return {
    canUpdate: false,
    updateCommand: codexStandaloneInstallCommand(binaryPath),
  };
}

function detectInstallSource(commandPath: string): 'npm' | 'bun' | 'pnpm' | 'homebrew' | 'unknown' {
  const normalized = commandPath.replaceAll('\\', '/').toLowerCase();
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

function codexStandaloneInstallCommand(binaryPath: string): string {
  const installEnv = ['CODEX_NON_INTERACTIVE=1'];
  if (binaryPath.includes('/') || binaryPath.includes('\\')) {
    installEnv.push(`CODEX_INSTALL_DIR=${shellQuote(dirname(binaryPath))}`);
  }
  return `curl -fsSL https://chatgpt.com/codex/install.sh | ${installEnv.join(' ')} sh`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
