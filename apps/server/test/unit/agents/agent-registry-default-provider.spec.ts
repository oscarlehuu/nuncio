import { ServiceUnavailableException } from '@nestjs/common';
import type { AgentProvider } from '../../../src/agents/agents.types';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { ClaudeAgentProvider } from '../../../src/agents/providers/claude-agent.provider';
import { CodexAgentProvider } from '../../../src/agents/providers/codex-agent.provider';
import { CursorAgentProvider } from '../../../src/agents/providers/cursor-agent.provider';
import { CursorCliProvider } from '../../../src/agents/providers/cursor-cli.provider';
import { DevinAgentProvider } from '../../../src/agents/providers/devin-agent.provider';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { SettingsService } from '../../../src/settings/settings.service';
import { stubAgentProvider } from '../../helpers/stub-agent-provider';

type AvailabilityProbe = () => Promise<boolean>;
type ProbeSet = Record<'pi' | 'cursor' | 'codex' | 'claude' | 'devin', AvailabilityProbe>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function registryWithProbes(probes: ProbeSet, mockProbe?: AvailabilityProbe): AgentRegistry {
  const provider = (id: string, name: string, isAvailable: AvailabilityProbe): AgentProvider => ({
    ...stubAgentProvider(id, name, false),
    isAvailable,
  });
  const cli = provider('cursor-cli', 'Cursor CLI', async () => false) as unknown as CursorCliProvider;
  const settings = { onChange: jest.fn() } as unknown as SettingsService;

  return new AgentRegistry(
    provider('pi', 'Nuncio Engine', probes.pi) as unknown as PiAgentProvider,
    provider('cursor', 'Cursor', probes.cursor) as unknown as CursorAgentProvider,
    provider('codex', 'Codex', probes.codex) as unknown as CodexAgentProvider,
    provider('claude', 'Claude', probes.claude) as unknown as ClaudeAgentProvider,
    cli,
    settings,
    provider('devin', 'Devin', probes.devin) as unknown as DevinAgentProvider,
    mockProbe ? provider('mock', 'Mock', mockProbe) : undefined,
  );
}

describe('AgentRegistry.defaultId priority', () => {
  it('returns a high-priority provider without starting lower-priority hung probes', async () => {
    const cursorAvailability = deferred<boolean>();
    const hungAvailability = deferred<boolean>();
    const cursorProbe = jest.fn(() => cursorAvailability.promise);
    const lowerProbes = [
      jest.fn(() => hungAvailability.promise),
      jest.fn(() => hungAvailability.promise),
      jest.fn(() => hungAvailability.promise),
      jest.fn(() => hungAvailability.promise),
    ];
    const registry = registryWithProbes({
      pi: lowerProbes[1]!,
      cursor: cursorProbe,
      codex: lowerProbes[0]!,
      claude: lowerProbes[2]!,
      devin: lowerProbes[3]!,
    });

    const selected = registry.defaultId();
    expect(cursorProbe).toHaveBeenCalledTimes(1);
    for (const probe of lowerProbes) expect(probe).not.toHaveBeenCalled();

    cursorAvailability.resolve(true);
    await expect(selected).resolves.toBe('cursor');
    for (const probe of lowerProbes) expect(probe).not.toHaveBeenCalled();
  });

  it('falls through unavailable preferences in order and stops after the winner', async () => {
    const cursorAvailability = deferred<boolean>();
    const codexAvailability = deferred<boolean>();
    const cursorProbe = jest.fn(() => cursorAvailability.promise);
    const codexProbe = jest.fn(() => codexAvailability.promise);
    const lowerProbe = jest.fn(async () => true);
    const registry = registryWithProbes({
      pi: lowerProbe,
      cursor: cursorProbe,
      codex: codexProbe,
      claude: lowerProbe,
      devin: lowerProbe,
    });

    const selected = registry.defaultId();
    expect(cursorProbe).toHaveBeenCalledTimes(1);
    expect(codexProbe).not.toHaveBeenCalled();

    cursorAvailability.resolve(false);
    await Promise.resolve();
    expect(codexProbe).toHaveBeenCalledTimes(1);
    expect(lowerProbe).not.toHaveBeenCalled();

    codexAvailability.resolve(true);
    await expect(selected).resolves.toBe('codex');
    expect(lowerProbe).not.toHaveBeenCalled();
  });

  it('probes each provider once through the final fallback', async () => {
    const order: string[] = [];
    const probe = (id: string, available: boolean) => jest.fn(async () => {
      order.push(id);
      return available;
    });
    const probes = {
      pi: probe('pi', false),
      cursor: probe('cursor', false),
      codex: probe('codex', false),
      claude: probe('claude', false),
      devin: probe('devin', true),
    };

    await expect(registryWithProbes(probes).defaultId()).resolves.toBe('devin');
    expect(order).toEqual(['cursor', 'codex', 'pi', 'claude', 'devin']);
    for (const providerProbe of Object.values(probes)) {
      expect(providerProbe).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps forced mock ahead of real provider preferences', async () => {
    const mockAvailability = deferred<boolean>();
    const hungAvailability = deferred<boolean>();
    const mockProbe = jest.fn(() => mockAvailability.promise);
    const realProbe = jest.fn(() => hungAvailability.promise);
    const registry = registryWithProbes({
      pi: realProbe,
      cursor: realProbe,
      codex: realProbe,
      claude: realProbe,
      devin: realProbe,
    }, mockProbe);

    const selected = registry.defaultId();
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(realProbe).not.toHaveBeenCalled();

    mockAvailability.resolve(true);
    await expect(selected).resolves.toBe('mock');
    expect(realProbe).not.toHaveBeenCalled();
  });

  it('preserves no-provider and probe-error failures', async () => {
    const unavailable = jest.fn(async () => false);
    const noneAvailable = registryWithProbes({
      pi: unavailable,
      cursor: unavailable,
      codex: unavailable,
      claude: unavailable,
      devin: unavailable,
    });
    await expect(noneAvailable.defaultId()).rejects.toThrow(ServiceUnavailableException);

    const failure = new Error('availability probe failed');
    const cursorProbe = jest.fn(async () => { throw failure; });
    const lowerProbe = jest.fn(async () => true);
    const failed = registryWithProbes({
      pi: lowerProbe,
      cursor: cursorProbe,
      codex: lowerProbe,
      claude: lowerProbe,
      devin: lowerProbe,
    });
    await expect(failed.defaultId()).rejects.toBe(failure);
    expect(lowerProbe).not.toHaveBeenCalled();
  });

  it('keeps available() probes parallel and preserves registry order', async () => {
    const states = {
      pi: deferred<boolean>(),
      cursor: deferred<boolean>(),
      codex: deferred<boolean>(),
      claude: deferred<boolean>(),
      devin: deferred<boolean>(),
    };
    const probes = {
      pi: jest.fn(() => states.pi.promise),
      cursor: jest.fn(() => states.cursor.promise),
      codex: jest.fn(() => states.codex.promise),
      claude: jest.fn(() => states.claude.promise),
      devin: jest.fn(() => states.devin.promise),
    };
    const available = registryWithProbes(probes).available();
    for (const providerProbe of Object.values(probes)) {
      expect(providerProbe).toHaveBeenCalledTimes(1);
    }

    states.devin.resolve(true);
    states.claude.resolve(false);
    states.codex.resolve(true);
    states.cursor.resolve(false);
    states.pi.resolve(true);
    await expect(available.then((providers) => providers.map(({ id }) => id))).resolves.toEqual([
      'pi', 'codex', 'devin',
    ]);
  });
});
