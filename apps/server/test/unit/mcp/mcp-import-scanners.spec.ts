import { parseCursorMcpConfig } from '../../../src/mcp/import/cursor-mcp-scanner';
import {
  parseClaudeGlobalConfig,
  parseClaudeProjectConfig,
} from '../../../src/mcp/import/claude-mcp-scanner';
import { parseCodexConfig } from '../../../src/mcp/import/codex-mcp-scanner';

describe('parseCursorMcpConfig', () => {
  const fixture = JSON.stringify({
    mcpServers: {
      'ios-simulator': { command: 'npx', args: ['-y', 'ios-simulator-mcp'] },
      bridgememory: {
        command: 'node',
        args: ['/x/server.cjs'],
        env: { BRIDGE_TOKEN: 'shh', BRIDGE_DIR: '/tmp' },
      },
      remote: { url: 'https://remote.example/mcp', headers: { Authorization: 'Bearer x' } },
    },
  });

  it('parses stdio and remote servers with secret detection', () => {
    const candidates = parseCursorMcpConfig(fixture, null);
    expect(candidates).toHaveLength(3);

    const sim = candidates.find((c) => c.name === 'ios-simulator');
    expect(sim?.transport).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'ios-simulator-mcp'] });
    expect(sim?.source).toBe('import:cursor');
    expect(sim?.projectPath).toBeNull();
    expect(sim?.enabled).toBe(true);

    const bridge = candidates.find((c) => c.name === 'bridgememory');
    expect(bridge?.secretKeys).toEqual(['BRIDGE_TOKEN']);

    const remote = candidates.find((c) => c.name === 'remote');
    expect(remote?.transport).toEqual({
      type: 'http',
      url: 'https://remote.example/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    expect(remote?.secretKeys).toEqual(['Authorization']);
  });

  it('scopes candidates to a project when given a project path', () => {
    const candidates = parseCursorMcpConfig(fixture, '/Users/me/proj');
    expect(candidates.every((c) => c.projectPath === '/Users/me/proj')).toBe(true);
  });

  it('returns [] for malformed json or missing mcpServers', () => {
    expect(parseCursorMcpConfig('not json', null)).toEqual([]);
    expect(parseCursorMcpConfig('{}', null)).toEqual([]);
  });
});

describe('parseClaudeGlobalConfig', () => {
  const fixture = JSON.stringify({
    mcpServers: {
      bridgememory: { type: 'stdio', command: 'node', args: ['/x/server.cjs'] },
    },
    projects: {
      '/Users/me/proj': {
        mcpServers: { projtool: { command: 'bunx', args: ['proj-tool-mcp'] } },
        otherJunk: true,
      },
      '/Users/me/empty': { otherJunk: true },
    },
  });

  it('parses global and project-scoped servers', () => {
    const candidates = parseClaudeGlobalConfig(fixture);
    expect(candidates).toHaveLength(2);
    expect(candidates.find((c) => c.name === 'bridgememory')?.projectPath).toBeNull();
    const proj = candidates.find((c) => c.name === 'projtool');
    expect(proj?.projectPath).toBe('/Users/me/proj');
    expect(proj?.source).toBe('import:claude');
  });

  it('parses sse remotes', () => {
    const candidates = parseClaudeGlobalConfig(
      JSON.stringify({ mcpServers: { r: { type: 'sse', url: 'https://sse.example/mcp' } } }),
    );
    expect(candidates[0].transport).toEqual({ type: 'sse', url: 'https://sse.example/mcp' });
  });

  it('parseClaudeProjectConfig scopes .mcp.json entries to the project', () => {
    const candidates = parseClaudeProjectConfig(
      JSON.stringify({ mcpServers: { local: { command: 'x', args: [] } } }),
      '/Users/me/proj',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].projectPath).toBe('/Users/me/proj');
  });
});

describe('parseCodexConfig', () => {
  const fixture = `
model = "gpt-5.5"

[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]

[mcp_servers.node_repl]
command = "uvx"
args = ["node-repl-mcp"]
enabled = false

[mcp_servers.node_repl.env]
NODE_TOKEN = "sekret"
NODE_MODE = "safe"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"

[mcp_servers.stripe]
url = "https://mcp.stripe.com"
oauth_resource = "https://mcp.stripe.com"
scopes = ["read"]

[mcp_servers.box]
url = "http://100.105.188.11:8099/mcp"

[mcp_servers.box.http_headers]
X-Box-Key = "abc"
`;

  it('parses stdio servers with env tables and enabled flags', () => {
    const candidates = parseCodexConfig(fixture, null);
    const playwright = candidates.find((c) => c.name === 'playwright');
    expect(playwright?.transport).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
    });
    expect(playwright?.enabled).toBe(true);

    const repl = candidates.find((c) => c.name === 'node_repl');
    expect(repl?.enabled).toBe(false);
    expect(repl?.transport).toEqual({
      type: 'stdio',
      command: 'uvx',
      args: ['node-repl-mcp'],
      env: { NODE_TOKEN: 'sekret', NODE_MODE: 'safe' },
    });
    expect(repl?.secretKeys).toEqual(['NODE_TOKEN']);
  });

  it('parses remote servers, marking explicit oauth config', () => {
    const candidates = parseCodexConfig(fixture, null);
    expect(candidates.find((c) => c.name === 'figma')?.transport).toEqual({
      type: 'http',
      url: 'https://mcp.figma.com/mcp',
    });
    expect(candidates.find((c) => c.name === 'figma')?.auth).toBe('none');
    expect(candidates.find((c) => c.name === 'stripe')?.auth).toBe('oauth');
    expect(candidates.find((c) => c.name === 'box')?.transport).toEqual({
      type: 'http',
      url: 'http://100.105.188.11:8099/mcp',
      headers: { 'X-Box-Key': 'abc' },
    });
    expect(candidates.find((c) => c.name === 'box')?.secretKeys).toEqual(['X-Box-Key']);
  });

  it('returns [] for malformed toml or configs without mcp_servers', () => {
    expect(parseCodexConfig('= broken', null)).toEqual([]);
    expect(parseCodexConfig('model = "gpt-5.5"', null)).toEqual([]);
  });
});
