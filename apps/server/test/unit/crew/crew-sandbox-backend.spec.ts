import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewCommandRunner } from '../../../src/crew/crew-command.runner';
import {
  CrewSandboxBackendRegistry, DEFAULT_CREW_SANDBOX_BACKEND, hostCrewSandboxBackend,
  type CrewSandboxBackend,
} from '../../../src/crew/crew-sandbox-backend';
import type { CrewSandboxLaunch } from '../../../src/crew/crew-command-sandbox';
import { CrewValidationError } from '../../../src/crew/domain/crew-errors';

// A fake backend that runs the command directly (no host sandbox). It exists only to prove the
// runner dispatches through the seam; production keeps the host Seatbelt/bubblewrap backend.
function fakeBackend(name = 'fake'): { backend: CrewSandboxBackend; builds: string[] } {
  const builds: string[] = [];
  const backend: CrewSandboxBackend = {
    name,
    isAvailable: () => true,
    build(command, cwd): CrewSandboxLaunch {
      builds.push(command);
      const tempDir = mkdtempSync(join(tmpdir(), 'crew-fake-backend-'));
      return { argv: ['/bin/sh', '-c', command], cwd, env: { PATH: '/usr/bin:/bin' }, tempDir };
    },
  };
  return { backend, builds };
}

describe('CrewSandboxBackendRegistry', () => {
  it('registers the host backend by default and resolves it for an absent name', () => {
    const registry = new CrewSandboxBackendRegistry();
    expect(registry.names()).toEqual([DEFAULT_CREW_SANDBOX_BACKEND]);
    expect(registry.resolve()).toBe(hostCrewSandboxBackend);
    expect(registry.resolve(DEFAULT_CREW_SANDBOX_BACKEND)).toBe(hostCrewSandboxBackend);
    expect(registry.has('host')).toBe(true);
  });

  it('accepts a second registered backend and selects it by name', () => {
    const { backend } = fakeBackend('container');
    const registry = new CrewSandboxBackendRegistry();
    registry.register(backend);
    expect(registry.names()).toEqual(expect.arrayContaining(['host', 'container']));
    expect(registry.resolve('container')).toBe(backend);
  });

  it('throws a clean validation error for an unknown backend and an empty name', () => {
    const registry = new CrewSandboxBackendRegistry();
    expect(() => registry.resolve('docker')).toThrow(CrewValidationError);
    expect(() => registry.resolve('docker')).toThrow('Unknown Crew sandbox backend: docker');
    expect(() => registry.register({ ...fakeBackend().backend, name: '  ' }))
      .toThrow(CrewValidationError);
  });
});

describe('CrewCommandRunner sandbox backend seam', () => {
  it('runs the default host backend byte-identically when no backend is selected', async () => {
    // No injected registry: the runner falls back to a fresh host-only registry, so the existing
    // no-argument construction still produces the confined Seatbelt/bubblewrap execution.
    const result = await new CrewCommandRunner().run("printf ok; exit 0", process.cwd(), 1000);
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok', spawnError: null });
  });

  it('dispatches through a registered fake backend selected per profile', async () => {
    const { backend, builds } = fakeBackend();
    const registry = new CrewSandboxBackendRegistry();
    registry.register(backend);
    const runner = new CrewCommandRunner(registry);
    const result = await runner.run(
      "printf routed; exit 0", process.cwd(), 1000, undefined, undefined, { backend: 'fake' },
    );
    expect(builds).toEqual(['printf routed; exit 0']);
    expect(result).toMatchObject({ exitCode: 0, stdout: 'routed', spawnError: null });
  });

  it('fails loudly for an unknown backend rather than masking it as a spawn error', async () => {
    const runner = new CrewCommandRunner(new CrewSandboxBackendRegistry());
    await expect(runner.run('true', process.cwd(), 1000, undefined, undefined, { backend: 'docker' }))
      .rejects.toThrow(CrewValidationError);
  });
});
