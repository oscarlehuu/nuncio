import { detectTransportSecrets, jsonEntryToTransport } from './json-mcp-entry';
import { readMcpServersBlock } from './cursor-mcp-scanner';
import type { McpImportCandidate } from './mcp-import.types';

/**
 * Parse the Claude Code global config (`~/.claude.json`): top-level
 * `mcpServers` (global scope) plus the per-project `projects.<path>.mcpServers`
 * map ("local"-scoped servers Claude keeps outside the repo).
 */
export function parseClaudeGlobalConfig(content: string): McpImportCandidate[] {
  let parsed: {
    mcpServers?: Record<string, unknown>;
    projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const candidates = entriesToCandidates(parsed?.mcpServers ?? {}, null);
  for (const [projectPath, project] of Object.entries(parsed?.projects ?? {})) {
    if (!project?.mcpServers || typeof project.mcpServers !== 'object') continue;
    candidates.push(...entriesToCandidates(project.mcpServers, projectPath));
  }
  return candidates;
}

/** Parse a project-shared `.mcp.json` (same `{ mcpServers }` shape, checked into the repo). */
export function parseClaudeProjectConfig(
  content: string,
  projectPath: string,
): McpImportCandidate[] {
  return entriesToCandidates(readMcpServersBlock(content), projectPath);
}

function entriesToCandidates(
  servers: Record<string, unknown>,
  projectPath: string | null,
): McpImportCandidate[] {
  return Object.entries(servers).flatMap(([name, entry]) => {
    const transport = jsonEntryToTransport(entry);
    if (!transport) return [];
    return [
      {
        name,
        transport,
        source: 'import:claude' as const,
        projectPath,
        enabled: true,
        auth: 'none' as const,
        ...detectTransportSecrets(transport),
      },
    ];
  });
}
