import { CrewVerifierService } from '../../../src/crew/crew-verifier.service';
import {
  CrewVerificationWorkspaceRegistry, DEFAULT_CREW_VERIFICATION_WORKSPACE,
} from '../../../src/crew/crew-verification-workspace-registry';
import {
  defaultCrewVerificationWorkspaceFactory,
  type CrewVerificationWorkspaceFactory,
} from '../../../src/crew/crew-verification-workspace';
import { CrewValidationError } from '../../../src/crew/domain/crew-errors';

const head = 'a'.repeat(40);
const boundary = {
  canonicalPath: '/repo', exists: true, symlink: false, branch: 'crew/run',
  fullHead: head, clean: true, reachable: true,
};
const stored = { artifact: { id: 'artifact-1' }, preview: 'bounded', truncated: false };
const passthrough: CrewVerificationWorkspaceFactory = {
  prepare: async ({ sourcePath }) => ({ path: sourcePath, dependencyRoot: null, cleanup: async () => {} }),
};
const okCommand = {
  exitCode: 0, stdout: '', stderr: '', durationMs: 1,
  timedOut: false, aborted: false, spawnError: null, outputOverflow: false,
};

describe('CrewVerificationWorkspaceRegistry', () => {
  it('registers git-snapshot by default and resolves it for an absent name', () => {
    const registry = new CrewVerificationWorkspaceRegistry();
    expect(registry.names()).toEqual([DEFAULT_CREW_VERIFICATION_WORKSPACE]);
    expect(registry.resolve()).toBe(defaultCrewVerificationWorkspaceFactory);
    expect(registry.resolve('git-snapshot')).toBe(defaultCrewVerificationWorkspaceFactory);
  });

  it('accepts a second strategy and selects it by name', () => {
    const registry = new CrewVerificationWorkspaceRegistry();
    registry.register('container', passthrough);
    expect(registry.names()).toEqual(expect.arrayContaining(['git-snapshot', 'container']));
    expect(registry.resolve('container')).toBe(passthrough);
  });

  it('throws a clean validation error for an unknown strategy and an empty name', () => {
    const registry = new CrewVerificationWorkspaceRegistry();
    expect(() => registry.resolve('docker')).toThrow(CrewValidationError);
    expect(() => registry.resolve('docker')).toThrow('Unknown Crew verification workspace strategy: docker');
    expect(() => registry.register('  ', passthrough)).toThrow(CrewValidationError);
  });
});

describe('CrewVerifierService workspace strategy seam', () => {
  it('uses the injected default factory when no strategy is selected', async () => {
    const defaultPrepare = jest.fn(passthrough.prepare);
    const registryPrepare = jest.fn(passthrough.prepare);
    const registry = new CrewVerificationWorkspaceRegistry();
    registry.register('fake', { prepare: registryPrepare });
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => boundary } as never,
      { run: async () => okCommand } as never,
      { writeLog: () => stored } as never,
      { prepare: defaultPrepare },
      registry,
    );
    await verifier.verify({ runId: 'r', command: 'check', cwd: '/repo', expectedHead: head });
    expect(defaultPrepare).toHaveBeenCalledTimes(1);
    expect(registryPrepare).not.toHaveBeenCalled();
  });

  it('selects the registered strategy factory by profile name', async () => {
    const registryPrepare = jest.fn(passthrough.prepare);
    const registry = new CrewVerificationWorkspaceRegistry();
    registry.register('fake', { prepare: registryPrepare });
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => boundary } as never,
      { run: async () => okCommand } as never,
      { writeLog: () => stored } as never,
      passthrough,
      registry,
    );
    await verifier.verify({
      runId: 'r', command: 'check', cwd: '/repo', expectedHead: head, verificationWorkspace: 'fake',
    });
    expect(registryPrepare).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown workspace strategy with a clean validation error', async () => {
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => boundary } as never,
      { run: async () => okCommand } as never,
      { writeLog: () => stored } as never,
      passthrough,
      new CrewVerificationWorkspaceRegistry(),
    );
    await expect(verifier.verify({
      runId: 'r', command: 'check', cwd: '/repo', expectedHead: head, verificationWorkspace: 'docker',
    })).rejects.toThrow(CrewValidationError);
  });

  it('threads the profile output cap and sandbox backend name to the runner', async () => {
    const run = jest.fn(async () => okCommand);
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => boundary } as never,
      { run } as never,
      { writeLog: () => stored } as never,
      passthrough,
      new CrewVerificationWorkspaceRegistry(),
    );
    await verifier.verify({
      runId: 'r', command: 'check', cwd: '/repo', expectedHead: head,
      sandboxBackend: 'container', outputCapBytes: 4096,
    });
    expect(run).toHaveBeenCalledWith(
      'check', '/repo', expect.any(Number), 4096, undefined,
      expect.objectContaining({ backend: 'container', sourceRoot: '/repo' }),
    );
  });

  it('leaves the runner defaults untouched when limits and backend are omitted', async () => {
    const run = jest.fn(async () => okCommand);
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => boundary } as never,
      { run } as never,
      { writeLog: () => stored } as never,
      passthrough,
      new CrewVerificationWorkspaceRegistry(),
    );
    await verifier.verify({ runId: 'r', command: 'check', cwd: '/repo', expectedHead: head });
    const call = run.mock.calls[0] as unknown[];
    expect(call[3]).toBeUndefined();
    expect(call[5]).toMatchObject({ backend: undefined, sourceRoot: '/repo' });
  });
});
