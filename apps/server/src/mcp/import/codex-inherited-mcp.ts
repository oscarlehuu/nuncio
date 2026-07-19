import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseCodexConfig } from '../import/codex-mcp-scanner';

/** Names of MCP servers declared in Codex config files (global + optional project). */
export function listInheritedCodexMcpServerNames(
  homeDir: string = homedir(),
  projectPath?: string | null,
): string[] {
  const names = new Set<string>();
  const readNames = (content: string, scope: string | null) => {
    for (const candidate of parseCodexConfig(content, scope)) {
      names.add(candidate.name);
    }
  };
  try {
    readNames(readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf8'), null);
  } catch {
    // no global Codex config
  }
  if (projectPath) {
    try {
      readNames(readFileSync(join(projectPath, '.codex', 'config.toml'), 'utf8'), projectPath);
    } catch {
      // no project Codex config
    }
  }
  return [...names];
}

export interface CodexMcpSuppressionConfig {
  mcp_servers: Record<string, { enabled: false }>;
}

/**
 * Disable inherited Codex MCP servers that Nuncio will serve through the bridge
 * for this session — prevents bridge + native double-load. Names only in
 * `~/.codex/config.toml` (not resolved in Nuncio) stay enabled natively.
 */
export function buildCodexMcpSuppressionConfig(
  inheritedNames: readonly string[],
  bridgeOwnedNames: ReadonlySet<string>,
): CodexMcpSuppressionConfig {
  const mcp_servers: Record<string, { enabled: false }> = {};
  for (const name of inheritedNames) {
    if (bridgeOwnedNames.has(name)) {
      mcp_servers[name] = { enabled: false };
    }
  }
  return { mcp_servers };
}
