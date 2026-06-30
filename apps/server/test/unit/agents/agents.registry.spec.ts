import { AgentRegistry } from '../../../src/agents/agents.registry';
import { CursorAgentProvider } from '../../../src/agents/providers/cursor-agent.provider';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { CursorCliProvider } from '../../../src/agents/providers/cursor-cli.provider';
import { SettingsService } from '../../../src/settings/settings.service';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';

describe('AgentRegistry.supportsInteraction', () => {
  const settings = { onChange: jest.fn() } as unknown as SettingsService;
  const pi = { id: 'pi', supportsInteraction: undefined } as unknown as PiAgentProvider;
  const cursor = { id: 'cursor', supportsInteraction: undefined } as unknown as CursorAgentProvider;
  const cli = {
    id: 'cursor-cli',
    supportsInteraction: () => true,
  } as unknown as CursorCliProvider;

  const registry = new AgentRegistry(pi, cursor, cli, settings);

  it('returns false for known providers without submitInteraction', () => {
    expect(registry.supportsInteraction('cursor')).toBe(false);
    expect(registry.supportsInteraction('pi')).toBe(false);
  });

  it('supportsInteractionForSession uses CLI provider for handoff sessions', () => {
    const session = {
      provider: 'cursor',
      cursorBackend: 'cli',
    } as SessionDto;

    expect(registry.supportsInteractionForSession(session)).toBe(true);
  });

  it('supportsInteractionForSession uses SDK provider for normal cursor sessions', () => {
    const session = {
      provider: 'cursor',
      cursorBackend: 'sdk',
    } as SessionDto;

    expect(registry.supportsInteractionForSession(session)).toBe(false);
  });
});
