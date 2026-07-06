import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Availability/auth probe for the Claude provider. The Claude Agent SDK bundles
 * a per-platform CLI binary as an optional dependency; that bundled binary rides
 * the shared keychain, so `auth status` returns the same login JSON as a system
 * `claude` install with no ANTHROPIC_API_KEY and no separate CLI install needed.
 *
 * A NUNCIO_CLAUDE_BIN setting overrides the binary path (system install, custom
 * build). The command runner is injectable so specs drive each auth branch
 * without spawning a real process.
 */

export type ClaudeCliCommandRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export type ClaudeCliResolutionStatus = 'ready' | 'not-found' | 'not-logged-in' | 'invalid';

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
  orgId?: string;
}

export interface ClaudeCliResolution {
  status: ClaudeCliResolutionStatus;
  binaryPath?: string;
  explicit: boolean;
  loggedIn: boolean;
  auth?: ClaudeAuthStatus;
  reason: string;
}

interface ResolveInput {
  configuredPath?: string;
  commandRunner: ClaudeCliCommandRunner;
  env?: NodeJS.ProcessEnv;
  /** Test hook: supply the bundled binary path without resolving node_modules. */
  bundledBinaryPath?: string | null;
}

/**
 * Locate the SDK-bundled CLI binary. The SDK ships the platform binary as an
 * optional dependency (`claude-agent-sdk-<platform>-<arch>`); package managers
 * that isolate the SDK's own node_modules (e.g. Bun's store) do not hoist that
 * sibling into a path resolvable from the app, so we resolve it in two steps:
 * first the SDK's own package.json, then the platform sibling *relative to the
 * SDK*, matching how the SDK itself locates the executable. Returns null when
 * the platform package is not installed (the probe then reports not-found unless
 * an explicit override is set).
 */
export function findBundledClaudeBinary(_env: NodeJS.ProcessEnv = process.env): string | null {
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const require = createRequire(__filename);
  let sdkPackageJson: string;
  try {
    sdkPackageJson = require.resolve('@anthropic-ai/claude-agent-sdk/package.json');
  } catch {
    return null;
  }

  const sdkRequire = createRequire(sdkPackageJson);
  try {
    const platformPackageJson = sdkRequire.resolve(`${platformPackage}/package.json`);
    const candidate = join(dirname(platformPackageJson), 'claude');
    if (executableExists(candidate)) return candidate;
  } catch {
    // Fall through to the SDK-adjacent layout below.
  }

  // Some layouts place the binary beside the SDK package itself.
  const adjacent = join(dirname(sdkPackageJson), 'claude');
  return executableExists(adjacent) ? adjacent : null;
}

export async function resolveClaudeCli(input: ResolveInput): Promise<ClaudeCliResolution> {
  const env = input.env ?? process.env;
  const configured = input.configuredPath?.trim();
  const explicit = Boolean(configured);
  const binaryPath = explicit
    ? expandHome(configured!, env)
    : input.bundledBinaryPath !== undefined
      ? input.bundledBinaryPath
      : findBundledClaudeBinary(env);

  if (!binaryPath) {
    return {
      status: 'not-found',
      explicit,
      loggedIn: false,
      reason:
        'No Claude CLI binary found. The Claude Agent SDK bundled binary is missing; set NUNCIO_CLAUDE_BIN to a claude executable.',
    };
  }

  let probe: { status: number | null; stdout: string; stderr: string };
  try {
    probe = await input.commandRunner(binaryPath, ['auth', 'status', '--json'], { env });
  } catch (error) {
    return {
      status: 'invalid',
      binaryPath,
      explicit,
      loggedIn: false,
      reason: `Claude CLI at ${binaryPath} could not be executed: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  const auth = parseAuthStatus(probe.stdout);
  if (!auth) {
    return {
      status: 'invalid',
      binaryPath,
      explicit,
      loggedIn: false,
      reason: `Claude CLI at ${binaryPath} did not return parseable auth status JSON.`,
    };
  }

  if (!auth.loggedIn) {
    return {
      status: 'not-logged-in',
      binaryPath,
      explicit,
      loggedIn: false,
      auth,
      reason: `Claude CLI at ${binaryPath} is not logged in. Run "${binaryPath} /login" or set ANTHROPIC_API_KEY.`,
    };
  }

  return {
    status: 'ready',
    binaryPath,
    explicit,
    loggedIn: true,
    auth,
    reason: `Claude CLI at ${binaryPath} is logged in${auth.subscriptionType ? ` (${auth.subscriptionType})` : ''}.`,
  };
}

/** Parse `auth status --json` output, tolerating extra log lines around the JSON object. */
export function parseAuthStatus(stdout: string): ClaudeAuthStatus | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      ...(typeof parsed.authMethod === 'string' ? { authMethod: parsed.authMethod } : {}),
      ...(typeof parsed.subscriptionType === 'string' ? { subscriptionType: parsed.subscriptionType } : {}),
      ...(typeof parsed.email === 'string' ? { email: parsed.email } : {}),
      ...(typeof parsed.orgId === 'string' ? { orgId: parsed.orgId } : {}),
    };
  } catch {
    return null;
  }
}

export function expandHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path === '~') return env.HOME || homedir();
  if (path.startsWith('~/')) return join(env.HOME || homedir(), path.slice(2));
  return path;
}

function executableExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
