import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../src/db/database.module';
import {
  MCP_SETTINGS_KEY,
  McpServersRepository,
} from '../../src/mcp/persistence/mcp-servers.repository';
import { McpService } from '../../src/mcp/mcp.service';
import { McpBridgeToolSource } from '../../src/mcp/bridge/mcp-bridge.tool-source';
import { SdkMcpClientFactory } from '../../src/mcp/bridge/mcp-client.factory';
import { normalizeAgentRuntimeToolResult } from '../../src/agents/tools/agent-runtime-tools.types';
import type { AgentRuntimeTool } from '../../src/agents/tools/agent-runtime-tools.types';

const FIXTURE = join(__dirname, 'fixtures', 'mcp-echo-server.ts');

function tool(tools: AgentRuntimeTool[] | undefined, name: string): AgentRuntimeTool {
  const found = tools?.find((entry) => entry.name === name);
  if (!found) throw new Error(`tool ${name} missing`);
  return found;
}

/**
 * End-to-end over the REAL MCP SDK: the bridge spawns the fixture stdio server
 * as a child process via SdkMcpClientFactory, lists its tools, and calls them —
 * proving the whole registry → resolve → pool → SDK transport chain works.
 */
describe('MCP bridge e2e (real stdio server)', () => {
  let module: TestingModule;
  let source: McpBridgeToolSource;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mcp-e2e-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        McpServersRepository,
        McpService,
        { provide: MCP_SETTINGS_KEY, useValue: randomBytes(32) },
      ],
    }).compile();
    const repo = module.get(McpServersRepository);
    repo.create({
      name: 'echo-fixture',
      description: 'test fixture server',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [FIXTURE],
        env: { WORKSPACE_ROOT: '${workspace}' },
      },
    });
    source = new McpBridgeToolSource(module.get(McpService), new SdkMcpClientFactory());
  });

  afterAll(async () => {
    source.onModuleDestroy();
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('discovers the fixture tools with schemas through nuncio_mcp_find_tools', async () => {
    const tools = source.forSession({
      sessionId: 'e2e',
      projectPath: null,
      provider: 'pi',
      workspace: '/tmp/e2e-workspace',
    });
    const result = normalizeAgentRuntimeToolResult(
      await tool(tools?.tools, 'nuncio_mcp_find_tools').execute({}),
    );
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      servers: Array<{ server: string; tools: Array<{ name: string; inputSchema: unknown }> }>;
    };
    const names = structured.servers[0].tools.map((entry) => entry.name).sort();
    expect(names).toEqual(['echo', 'workspace_root']);
    expect(structured.servers[0].tools[0].inputSchema).toBeDefined();
  }, 30_000);

  it('invokes a tool and resolves ${workspace} into the server env', async () => {
    const tools = source.forSession({
      sessionId: 'e2e',
      projectPath: null,
      provider: 'pi',
      workspace: '/tmp/e2e-workspace',
    });
    const call = tool(tools?.tools, 'nuncio_mcp_call');

    const echoed = normalizeAgentRuntimeToolResult(
      await call.execute({ server: 'echo-fixture', tool: 'echo', args: { text: 'xin chao' } }),
    );
    expect(echoed.isError).toBeFalsy();
    expect(echoed.content[0]).toEqual({ type: 'text', text: 'echo:xin chao' });

    const workspace = normalizeAgentRuntimeToolResult(
      await call.execute({ server: 'echo-fixture', tool: 'workspace_root' }),
    );
    expect(workspace.content[0]).toEqual({ type: 'text', text: '/tmp/e2e-workspace' });
  }, 30_000);
});
