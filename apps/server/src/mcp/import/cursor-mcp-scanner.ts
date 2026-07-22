import { detectTransportSecrets, jsonEntryToTransport } from './json-mcp-entry';
import type { McpImportCandidate } from './mcp-import.types';

/**
 * Parse a Cursor `mcp.json` document (`~/.cursor/mcp.json` globally, or
 * `<project>/.cursor/mcp.json` when `projectPath` is set).
 */
export function parseCursorMcpConfig(
  content: string,
  projectPath: string | null,
): McpImportCandidate[] {
  const servers = readMcpServersBlock(content);
  return Object.entries(servers).flatMap(([name, entry]) => {
    const transport = jsonEntryToTransport(entry);
    if (!transport) return [];
    return [
      {
        name,
        transport,
        source: 'import:cursor' as const,
        projectPath,
        enabled: true,
        auth: 'none' as const,
        ...detectTransportSecrets(transport),
      },
    ];
  });
}

export function readMcpServersBlock(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
    return parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}
