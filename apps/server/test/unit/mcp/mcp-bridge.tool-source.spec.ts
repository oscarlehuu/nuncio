import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import {
  MCP_SETTINGS_KEY,
  McpServersRepository,
} from '../../../src/mcp/persistence/mcp-servers.repository';
import { McpService } from '../../../src/mcp/mcp.service';
import { McpBridgeToolSource } from '../../../src/mcp/bridge/mcp-bridge.tool-source';
import { McpOAuthRepository } from '../../../src/mcp/persistence/mcp-oauth.repository';
import { McpOAuthService } from '../../../src/mcp/oauth/mcp-oauth.service';
import type {
  McpBridgeClient,
  McpClientFactory,
  McpToolDescriptor,
} from '../../../src/mcp/bridge/mcp-client.types';
import type { McpTransport } from '../../../src/mcp/domain/mcp.types';
import { normalizeAgentRuntimeToolResult } from '../../../src/agents/tools/agent-runtime-tools.types';
import type { AgentRuntimeTool } from '../../../src/agents/tools/agent-runtime-tools.types';

interface FakeServerBehavior {
  tools?: McpToolDescriptor[];
  failConnect?: boolean;
  failCall?: boolean;
  callResult?: { content: Array<{ type: 'text'; text: string }> };
}

function makeFactory(behaviors: Record<string, FakeServerBehavior>) {
  const connects: McpTransport[] = [];
  const calls: Array<{ command: string; tool: string; args: Record<string, unknown> }> = [];
  const factory: McpClientFactory = {
    async connect(transport) {
      connects.push(transport);
      const command = transport.type === 'stdio' ? transport.command : transport.url;
      const behavior = behaviors[command] ?? {};
      if (behavior.failConnect) throw new Error(`cannot start ${command}`);
      const client: McpBridgeClient = {
        async listTools() {
          return behavior.tools ?? [];
        },
        async callTool(tool, args) {
          if (behavior.failCall) throw new Error(`transport lost for ${command}`);
          calls.push({ command, tool, args });
          return behavior.callResult ?? { content: [{ type: 'text', text: `${tool} ok` }] };
        },
        async close() {},
      };
      return client;
    },
  };
  return { factory, connects, calls };
}

const echoTool: McpToolDescriptor = {
  name: 'echo',
  description: 'Echoes input back',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};
const searchTool: McpToolDescriptor = {
  name: 'search_memories',
  description: 'Search stored memories',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};

function toolByName(tools: AgentRuntimeTool[] | undefined, name: string): AgentRuntimeTool {
  const tool = tools?.find((entry) => entry.name === name);
  if (!tool) throw new Error(`tool ${name} not advertised`);
  return tool;
}

async function runTool(tool: AgentRuntimeTool, input: Record<string, unknown>) {
  return normalizeAgentRuntimeToolResult(await tool.execute(input));
}

describe('McpBridgeToolSource', () => {
  let module: TestingModule;
  let repo: McpServersRepository;
  let service: McpService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mcp-bridge-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        McpServersRepository,
        McpOAuthRepository,
        McpService,
        { provide: MCP_SETTINGS_KEY, useValue: randomBytes(32) },
      ],
    }).compile();
    repo = module.get(McpServersRepository);
    service = module.get(McpService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    for (const server of repo.list()) repo.delete(server.id);
  });

  const scope = { sessionId: 's1', projectPath: null, provider: 'pi', model: null };

  it('returns undefined when no servers resolve for the session', () => {
    const { factory } = makeFactory({});
    const source = new McpBridgeToolSource(service, factory);
    expect(source.forSession(scope)).toBeUndefined();
  });

  it('advertises the two gateway tools plus an inventory line per server', () => {
    repo.create({
      name: 'bridgememory',
      description: 'persistent memory graph',
      transport: { type: 'stdio', command: 'bridge', args: [] },
    });
    repo.create({ name: 'figma', transport: { type: 'http', url: 'https://mcp.figma.com/mcp' } });
    const { factory, connects } = makeFactory({});
    const source = new McpBridgeToolSource(service, factory);
    const tools = source.forSession(scope);
    expect(tools?.tools.map((tool) => tool.name).sort()).toEqual([
      'nuncio_mcp_call',
      'nuncio_mcp_find_tools',
    ]);
    expect(tools?.systemPromptAppend).toContain('bridgememory — persistent memory graph');
    expect(tools?.systemPromptAppend).toContain('figma');
    expect(tools?.systemPromptAppend).toContain('nuncio_mcp_find_tools');
    // Advertising must never spawn a server.
    expect(connects).toHaveLength(0);
    const security = toolByName(tools?.tools, 'nuncio_mcp_call').security;
    expect(security?.network).toBe('required');
    expect(security?.scope).toBe('session');
    expect(security?.runtimePolicies).toEqual([]);
  });

  it('find_tools connects lazily, lists schemas, and filters by query', async () => {
    repo.create({
      name: 'bridgememory',
      transport: { type: 'stdio', command: 'bridge', args: [] },
    });
    const { factory, connects } = makeFactory({ bridge: { tools: [echoTool, searchTool] } });
    const source = new McpBridgeToolSource(service, factory);
    const findTools = toolByName(source.forSession(scope)?.tools, 'nuncio_mcp_find_tools');

    const all = await runTool(findTools, {});
    expect(connects).toHaveLength(1);
    expect(all.isError).toBeFalsy();
    const structured = all.structuredContent as {
      servers: Array<{ server: string; tools: McpToolDescriptor[] }>;
    };
    expect(structured.servers[0].server).toBe('bridgememory');
    expect(structured.servers[0].tools).toHaveLength(2);
    expect(structured.servers[0].tools[0].inputSchema).toBeDefined();

    const filtered = await runTool(findTools, { query: 'memor' });
    const filteredStructured = filtered.structuredContent as {
      servers: Array<{ tools: McpToolDescriptor[] }>;
    };
    expect(filteredStructured.servers[0].tools.map((tool) => tool.name)).toEqual([
      'search_memories',
    ]);
  });

  it('find_tools reports unreachable servers per-entry instead of failing the call', async () => {
    repo.create({ name: 'good', transport: { type: 'stdio', command: 'good', args: [] } });
    repo.create({ name: 'broken', transport: { type: 'stdio', command: 'broken', args: [] } });
    const { factory } = makeFactory({
      good: { tools: [echoTool] },
      broken: { failConnect: true },
    });
    const source = new McpBridgeToolSource(service, factory);
    const findTools = toolByName(source.forSession(scope)?.tools, 'nuncio_mcp_find_tools');
    const result = await runTool(findTools, {});
    const structured = result.structuredContent as {
      servers: Array<{ server: string; tools?: unknown[]; error?: string }>;
    };
    expect(structured.servers.find((entry) => entry.server === 'good')?.tools).toHaveLength(1);
    expect(structured.servers.find((entry) => entry.server === 'broken')?.error).toContain(
      'cannot start',
    );
  });

  it('redacts imported transport secrets from rendered bridge errors', async () => {
    repo.create({
      name: 'secret-error',
      transport: {
        type: 'http',
        url: 'https://remote.example/mcp?tenant=query-error-secret',
        headers: { 'X-Account': 'header-error-secret' },
      },
      sources: ['import:cursor'],
      secretKeys: ['X-Account'],
      secretArgIndexes: [],
      secretUrlQueryKeys: ['tenant'],
    } as never);
    const factory: McpClientFactory = {
      async connect() {
        throw new Error(
          'failed https://remote.example/mcp?tenant=query-error-secret with header-error-secret',
        );
      },
    };
    const source = new McpBridgeToolSource(service, factory);
    const findTools = toolByName(source.forSession(scope)?.tools, 'nuncio_mcp_find_tools');
    const result = await runTool(findTools, {});
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('query-error-secret');
    expect(serialized).not.toContain('header-error-secret');
    expect(serialized).toContain('failed');
  });

  it('redacts raw, percent-encoded, and plus-encoded payloads inside marked arguments', async () => {
    repo.create({
      name: 'argument-secret-error',
      transport: {
        type: 'stdio',
        command: 'argument-secret-server',
        args: [
          '--api-key=inline-secret',
          'https://args.example/mcp?token=query+secret',
        ],
      },
      sources: ['import:cursor'],
      secretArgIndexes: [0, 1],
    });
    const factory: McpClientFactory = {
      async connect() {
        throw new Error(
          'failed inline-secret inline%2Dsecret query secret query+secret query%20secret',
        );
      },
    };
    const source = new McpBridgeToolSource(service, factory);
    const findTools = toolByName(source.forSession(scope)?.tools, 'nuncio_mcp_find_tools');

    const result = await runTool(findTools, {});
    const serialized = JSON.stringify(result);
    for (const leaked of [
      'inline-secret',
      'inline%2Dsecret',
      'query secret',
      'query+secret',
      'query%20secret',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(serialized).toContain('[redacted]');
  });

  it('redacts nested percent and plus encodings within fixed bounds without touching unrelated text', async () => {
    const longEncodedSecret = `${'x'.repeat(9_000)}inline%252Dsecret`;
    repo.create({
      name: 'nested-encoding-error',
      transport: {
        type: 'stdio',
        command: 'nested-encoding-server',
        args: [
          '--api-key=inline-secret',
          'https://args.example/mcp?token=query+secret',
        ],
      },
      secretArgIndexes: [0, 1],
    });
    const factory: McpClientFactory = {
      async connect() {
        throw new Error(
          'failed inline%252Dsecret inline%25252Dsecret ' +
            'query%2520secret query%25252Bsecret ' +
            `public%252Dvalue public%25252Bvalue ${longEncodedSecret}`,
        );
      },
    };
    const source = new McpBridgeToolSource(service, factory);
    const findTools = toolByName(source.forSession(scope)?.tools, 'nuncio_mcp_find_tools');

    const result = await runTool(findTools, {});
    const serialized = JSON.stringify(result);
    for (const leaked of [
      'inline%252Dsecret',
      'inline%25252Dsecret',
      'query%2520secret',
      'query%25252Bsecret',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(serialized).not.toContain('x'.repeat(128));
    expect(serialized).toContain('public%252Dvalue');
    expect(serialized).toContain('public%25252Bvalue');
  });

  it('call routes to the right server and maps the outcome', async () => {
    repo.create({ name: 'bridgememory', transport: { type: 'stdio', command: 'bridge', args: [] } });
    const { factory, calls } = makeFactory({ bridge: { tools: [echoTool] } });
    const source = new McpBridgeToolSource(service, factory);
    const call = toolByName(source.forSession(scope)?.tools, 'nuncio_mcp_call');
    const result = await runTool(call, {
      server: 'bridgememory',
      tool: 'echo',
      args: { text: 'hi' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo ok' });
    expect(calls).toEqual([{ command: 'bridge', tool: 'echo', args: { text: 'hi' } }]);
  });

  it('call with an unknown server returns isError listing available ids', async () => {
    repo.create({ name: 'known', transport: { type: 'stdio', command: 'known', args: [] } });
    const { factory } = makeFactory({});
    const source = new McpBridgeToolSource(service, factory);
    const call = toolByName(source.forSession(scope)?.tools, 'nuncio_mcp_call');
    const result = await runTool(call, { server: 'ghost', tool: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as { text: string }).text).toContain('known');
  });

  it('call maps a transport error to isError and reconnects on the next call', async () => {
    repo.create({ name: 'flaky', transport: { type: 'stdio', command: 'flaky', args: [] } });
    const behaviors: Record<string, FakeServerBehavior> = { flaky: { failCall: true } };
    const { factory, connects } = makeFactory(behaviors);
    const source = new McpBridgeToolSource(service, factory);
    const call = toolByName(source.forSession(scope)?.tools, 'nuncio_mcp_call');

    const failed = await runTool(call, { server: 'flaky', tool: 'x' });
    expect(failed.isError).toBe(true);
    expect((failed.content[0] as { text: string }).text).toContain('transport lost');

    behaviors.flaky.failCall = false;
    const ok = await runTool(call, { server: 'flaky', tool: 'x' });
    expect(ok.isError).toBeFalsy();
    expect(connects).toHaveLength(2);
  });

  it('resolves ${workspace} against the session workspace before connecting', async () => {
    repo.create({
      name: 'scoped',
      transport: { type: 'stdio', command: 'scoped', args: ['--root', '${workspace}'] },
    });
    const { factory, connects } = makeFactory({ scoped: { tools: [] } });
    const source = new McpBridgeToolSource(service, factory);
    const tools = source.forSession({ ...scope, workspace: '/tmp/wt-42' });
    const findTools = toolByName(tools?.tools, 'nuncio_mcp_find_tools');
    await runTool(findTools, {});
    expect(connects[0]).toEqual({
      type: 'stdio',
      command: 'scoped',
      args: ['--root', '/tmp/wt-42'],
    });
  });

  it('marks oauth servers without tokens as auth required in the inventory', () => {
    repo.create({
      name: 'oauth-remote',
      description: 'needs login',
      transport: { type: 'http', url: 'https://oauth.example/mcp' },
      auth: 'oauth',
    });
    const oauthRepo = module.get(McpOAuthRepository);
    const oauthService = new McpOAuthService(repo, oauthRepo);
    const { factory } = makeFactory({});
    const source = new McpBridgeToolSource(service, factory, oauthService);
    const tools = source.forSession(scope);
    expect(tools?.systemPromptAppend).toContain('(auth required)');
  });

  it('full-advertise servers expose direct tools once schemas are warmed', async () => {
    const created = service.create({
      name: 'bridgememory',
      transport: { type: 'stdio', command: 'bridge', args: [] },
      advertise: 'full',
    });
    const { factory } = makeFactory({ bridge: { tools: [searchTool] } });
    const source = new McpBridgeToolSource(service, factory);

    const cold = source.forSession(scope);
    expect(cold?.tools.map((tool) => tool.name)).not.toContain('bridgememory_search_memories');

    await source.ensureSchemas(created.id, null);
    const warm = source.forSession(scope);
    const direct = toolByName(warm?.tools, 'bridgememory_search_memories');
    expect(direct.description).toContain('Search stored memories');
    const result = await runTool(direct, { query: 'x' });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('search_memories ok');
  });
});
