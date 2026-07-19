import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCodexMcpSuppressionConfig,
  listInheritedCodexMcpServerNames,
} from '../../../src/mcp/import/codex-inherited-mcp';

const SAMPLE_TOML = `
[mcp_servers.bridgememory]
command = "node"
args = ["server.cjs"]

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
`;

describe('codex inherited MCP helpers', () => {
  it('buildCodexMcpSuppressionConfig disables inherited names that Nuncio bridges', () => {
    const config = buildCodexMcpSuppressionConfig(
      ['bridgememory', 'figma', 'playwright'],
      new Set(['bridgememory']),
    );
    expect(config.mcp_servers).toEqual({
      bridgememory: { enabled: false },
    });
  });

  it('leaves inherited-only servers enabled when Nuncio does not resolve them', () => {
    const config = buildCodexMcpSuppressionConfig(['figma', 'playwright'], new Set());
    expect(config.mcp_servers).toEqual({});
  });

  it('parses names from Codex config content via listInheritedCodexMcpServerNames reader', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-inherited-home-'));
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'config.toml'), SAMPLE_TOML);
    expect(listInheritedCodexMcpServerNames(home).sort()).toEqual(['bridgememory', 'figma']);
    rmSync(home, { recursive: true, force: true });
  });
});
