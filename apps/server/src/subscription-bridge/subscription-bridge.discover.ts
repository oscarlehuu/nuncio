import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CliproxyParsedApiKey {
  index: number;
  preview: string;
  /** Present only while parsing in-process — never returned from discover(). */
  raw: string;
}

export interface CliproxyParsedConfig {
  port: number | null;
  authDir: string | null;
  apiKeys: CliproxyParsedApiKey[];
}

export interface CliproxyDiscoveryDto {
  configPath: string;
  port: number | null;
  authDir: string | null;
  binaryPath: string | null;
  baseUrl: string | null;
  accounts: { claude: boolean; codex: boolean };
  /** Masked previews only — never raw secrets. */
  apiKeys: Array<{ index: number; preview: string }>;
}

export interface DiscoverCliproxyOptions {
  homeDir?: string;
  candidateConfigPaths?: string[];
  candidateBinPaths?: string[];
}

const DEFAULT_MANAGED_PORT = 18317;

/** Default listen port when Nuncio supervises CLIProxyAPI (avoids clashing with a user's :8317). */
export function defaultManagedCliproxyPort(): number {
  return DEFAULT_MANAGED_PORT;
}

export function maskApiKeyPreview(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '••••';
  if (trimmed.length <= 4) return `••••${trimmed}`;
  return `••••${trimmed.slice(-8)}`;
}

/**
 * Minimal YAML extractor for CLIProxyAPI config — enough for port / auth-dir / api-keys.
 * Avoids a hard dependency on a YAML parser for discovery.
 */
export function parseCliproxyConfigYaml(text: string): CliproxyParsedConfig {
  const portMatch = text.match(/^\s*port:\s*(\d+)\s*$/m);
  const authMatch = text.match(/^\s*auth-dir:\s*["']?([^"'\n#]+)["']?\s*$/m);
  const apiKeys: CliproxyParsedApiKey[] = [];
  const keysBlock = text.match(/^\s*api-keys:\s*\n((?:\s*-\s*.+\n?)*)/m);
  if (keysBlock?.[1]) {
    const lines = keysBlock[1].split('\n');
    for (const line of lines) {
      const keyMatch = line.match(/^\s*-\s*["']?([^"'\n#]+?)["']?\s*$/);
      if (!keyMatch?.[1]) continue;
      const raw = keyMatch[1].trim();
      if (!raw) continue;
      apiKeys.push({ index: apiKeys.length, preview: maskApiKeyPreview(raw), raw });
    }
  }

  return {
    port: portMatch ? Number(portMatch[1]) : null,
    authDir: authMatch?.[1]?.trim() || null,
    apiKeys,
  };
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

function detectAuthAccounts(authDir: string | null, home: string): { claude: boolean; codex: boolean } {
  if (!authDir) return { claude: false, codex: false };
  const resolved = expandHome(authDir, home);
  if (!existsSync(resolved)) return { claude: false, codex: false };
  let names: string[] = [];
  try {
    names = readdirSync(resolved).map((n) => n.toLowerCase());
  } catch {
    return { claude: false, codex: false };
  }
  const claude = names.some((n) => n.includes('claude'));
  const codex = names.some((n) => n.includes('codex'));
  return { claude, codex };
}

function defaultCandidateConfigs(home: string): string[] {
  return [
    join(home, 'cliproxyapi', 'config.yaml'),
    join(home, '.cli-proxy-api', 'config.yaml'),
    join(home, '.config', 'cliproxyapi', 'config.yaml'),
  ];
}

function defaultCandidateBins(home: string): string[] {
  return [
    join(home, 'cliproxyapi', 'cli-proxy-api'),
    join(home, '.local', 'bin', 'cli-proxy-api'),
  ];
}

function resolveBinaryNearConfig(configPath: string, candidateBins: string[]): string | null {
  const sibling = join(dirname(configPath), 'cli-proxy-api');
  if (existsSync(sibling)) return sibling;
  for (const bin of candidateBins) {
    if (existsSync(bin)) return bin;
  }
  return null;
}

/** Scan the host for existing CLIProxyAPI installs (case 1 — external service). */
export function discoverCliproxyInstalls(opts: DiscoverCliproxyOptions = {}): CliproxyDiscoveryDto[] {
  const home = opts.homeDir ?? homedir();
  const configs = opts.candidateConfigPaths ?? defaultCandidateConfigs(home);
  const bins = opts.candidateBinPaths ?? defaultCandidateBins(home);
  const out: CliproxyDiscoveryDto[] = [];
  const seen = new Set<string>();

  for (const configPath of configs) {
    if (!existsSync(configPath) || seen.has(configPath)) continue;
    seen.add(configPath);
    let text: string;
    try {
      text = readFileSync(configPath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseCliproxyConfigYaml(text);
    const authDir = parsed.authDir;
    const binaryPath = resolveBinaryNearConfig(configPath, bins);
    const port = parsed.port;
    out.push({
      configPath,
      port,
      authDir,
      binaryPath,
      baseUrl: port != null ? `http://127.0.0.1:${port}` : null,
      accounts: detectAuthAccounts(authDir, home),
      apiKeys: parsed.apiKeys.map(({ index, preview }) => ({ index, preview })),
    });
  }

  return out;
}

/** Read one config path for migrate/adopt (includes raw keys in-process only). */
export function readCliproxyConfigFile(
  configPath: string,
  homeDir = homedir(),
): CliproxyParsedConfig & { configPath: string; accounts: { claude: boolean; codex: boolean } } {
  const text = readFileSync(configPath, 'utf8');
  const parsed = parseCliproxyConfigYaml(text);
  return {
    ...parsed,
    configPath,
    accounts: detectAuthAccounts(parsed.authDir, homeDir),
  };
}
