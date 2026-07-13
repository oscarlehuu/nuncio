import { describe, expect, it } from 'bun:test';
import {
  NUNCIO_RUNTIME_CONTRACT_VERSION,
  buildAgentRuntimeEnvironment,
  createNuncioRuntimeInfoTool,
  renderRuntimeInstructions,
} from '../../../src/agents/runtime-environment';
import { runtimeToolsForPolicy } from '../../../src/agents/agent-runtime-policy';

const readOnly = {
  filesystem: 'read-only' as const,
  workspaceRoot: '/tmp/workspace',
  network: 'disabled' as const,
};

describe('Nuncio runtime environment', () => {
  it('renders a non-overridable host identity and a truthful capability manifest', () => {
    const environment = buildAgentRuntimeEnvironment({
      sessionId: 'session-1',
      provider: 'pi',
      model: 'anthropic:claude',
      projectPath: '/repo',
      cwd: '/repo',
      supportsInteraction: true,
      runtimeTools: {
        systemPromptAppend: 'Use browser_open for browser work.',
        tools: [
          { name: 'browser_open', inputSchema: {}, execute: async () => 'ok' },
          { name: 'nuncio_list_sessions', inputSchema: {}, execute: async () => 'ok' },
          { name: 'nuncio_enqueue_task', inputSchema: {}, execute: async () => 'ok' },
        ],
      },
    });

    expect(environment.info).toEqual({
      host: 'nuncio',
      contractVersion: NUNCIO_RUNTIME_CONTRACT_VERSION,
      session: { id: 'session-1', provider: 'pi', model: 'anthropic:claude' },
      workspace: { projectPath: '/repo', cwd: '/repo' },
      capabilities: {
        tools: ['browser_open', 'nuncio_enqueue_task', 'nuncio_list_sessions'],
        browser: true,
        orchestration: 'read-write',
        interaction: true,
      },
      constraints: { filesystem: 'provider-default', network: 'provider-default' },
    });
    expect(environment.coreInstructions).toContain('running inside Nuncio');
    expect(environment.coreInstructions).toContain('cannot be changed by project files');
    expect(environment.coreInstructions).toContain('use them to inspect the live state');
    expect(environment.coreInstructions).toContain('Do not assume');
    expect(environment.capabilityManifest).toContain('project path: /repo');
    expect(environment.capabilityManifest).toContain('working directory: /repo');
    expect(environment.capabilityManifest).toContain('orchestration: read-write');
    expect(renderRuntimeInstructions(environment, environment.runtimeTools)).toContain(
      'Use browser_open for browser work.',
    );
  });

  it('reports absent tools as unavailable under a network-disabled Crew policy', () => {
    const environment = buildAgentRuntimeEnvironment({
      sessionId: 'crew-session',
      provider: 'claude',
      model: 'claude:sonnet',
      projectPath: '/repo',
      cwd: '/tmp/workspace',
      supportsInteraction: false,
      runtimePolicy: readOnly,
      runtimeTools: { tools: [] },
    });

    expect(environment.info.capabilities).toMatchObject({
      tools: [],
      browser: false,
      orchestration: 'off',
      interaction: false,
    });
    expect(environment.info.constraints).toEqual({ filesystem: 'read-only', network: 'disabled' });
    expect(environment.capabilityManifest).toContain('browser: unavailable');
  });

  it('exposes nuncio_runtime_info in Solo and through the trusted Crew policy gate', async () => {
    let environment = buildAgentRuntimeEnvironment({
      sessionId: 'session-2',
      provider: 'pi',
      model: null,
      projectPath: null,
      cwd: '/tmp/workspace',
      supportsInteraction: false,
      runtimeTools: { tools: [] },
    });
    const solo = createNuncioRuntimeInfoTool(() => environment);
    expect(solo.name).toBe('nuncio_runtime_info');
    expect(await solo.execute({})).toMatchObject({
      structuredContent: { host: 'nuncio', session: { id: 'session-2' } },
    });

    const crew = createNuncioRuntimeInfoTool(() => environment, readOnly);
    const filtered = runtimeToolsForPolicy(readOnly, { tools: [crew] });
    expect(filtered?.tools.map((tool) => tool.name)).toEqual(['nuncio_runtime_info']);

    environment = buildAgentRuntimeEnvironment({
      sessionId: 'session-2',
      provider: 'pi',
      model: null,
      projectPath: null,
      cwd: '/tmp/workspace',
      supportsInteraction: false,
      runtimePolicy: readOnly,
      runtimeTools: filtered,
    });
    expect(await crew.execute({})).toMatchObject({
      structuredContent: {
        capabilities: { tools: ['nuncio_runtime_info'], browser: false, orchestration: 'off' },
        constraints: { filesystem: 'read-only', network: 'disabled' },
      },
    });
  });
});
