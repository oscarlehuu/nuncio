import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTAINER_CREW_SANDBOX_BACKEND, DEFAULT_CREW_CONTAINER_IMAGE,
  buildContainerSandboxLaunch, containerCrewSandboxBackend, isCrewContainerRuntimeAvailable,
  resetContainerRuntimeProbeCache, resolveContainerRuntime,
} from '../../../src/crew/crew-container-sandbox';

const runtime = { bin: '/fake/bin/docker', kind: 'docker' as const };
const available = () => true;
const cleanups: string[] = [];

function build(cwd: string, options = {}) {
  const launch = buildContainerSandboxLaunch('printf ok', cwd, options, runtime, available);
  cleanups.push(launch.tempDir);
  return launch;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetContainerRuntimeProbeCache();
});

describe('resolveContainerRuntime', () => {
  it('prefers docker, then podman, then none', () => {
    expect(resolveContainerRuntime((bin) => (bin === 'docker' ? '/u/docker' : '/u/podman')))
      .toEqual({ bin: '/u/docker', kind: 'docker' });
    expect(resolveContainerRuntime((bin) => (bin === 'podman' ? '/u/podman' : null)))
      .toEqual({ bin: '/u/podman', kind: 'podman' });
    expect(resolveContainerRuntime(() => null)).toBeNull();
  });
});

describe('isCrewContainerRuntimeAvailable', () => {
  it('is false with no runtime and never probes', () => {
    let probed = false;
    expect(isCrewContainerRuntimeAvailable(null, () => { probed = true; return true; })).toBe(false);
    expect(probed).toBe(false);
  });

  it('reflects the daemon probe and caches per binary', () => {
    let calls = 0;
    const probe = () => { calls += 1; return true; };
    expect(isCrewContainerRuntimeAvailable({ bin: '/x/docker', kind: 'docker' }, probe)).toBe(true);
    expect(isCrewContainerRuntimeAvailable({ bin: '/x/docker', kind: 'docker' }, probe)).toBe(true);
    expect(calls).toBe(1);
  });

  it('reports unavailable when the daemon probe fails', () => {
    expect(isCrewContainerRuntimeAvailable({ bin: '/y/docker', kind: 'docker' }, () => false)).toBe(false);
  });
});

describe('buildContainerSandboxLaunch', () => {
  let cwd: string;
  beforeEach(() => { cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'crew-container-cwd-'))); });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('refuses to build when the runtime is unavailable', () => {
    expect(() => buildContainerSandboxLaunch('printf ok', cwd, {}, runtime, () => false))
      .toThrow('refusing unsandboxed execution');
    expect(() => buildContainerSandboxLaunch('printf ok', cwd, {}, null, available))
      .toThrow('refusing unsandboxed execution');
  });

  it('disables the network, drops privileges, and runs the command under /bin/sh', () => {
    const { argv } = build(cwd);
    expect(argv[0]).toBe(runtime.bin);
    expect(flagValue(argv, '--network')).toBe('none');
    expect(argv).toContain('--read-only');
    expect(argv).toContain('--cap-drop');
    expect(argv).toContain('--security-opt');
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'printf ok']);
  });

  it('applies the default image and resource limits', () => {
    const { argv } = build(cwd);
    expect(argv[argv.length - 4]).toBe(DEFAULT_CREW_CONTAINER_IMAGE);
    expect(flagValue(argv, '--memory')).toBe('2048m');
    expect(flagValue(argv, '--cpus')).toBe('2');
    expect(flagValue(argv, '--pids-limit')).toBe('512');
  });

  it('honors a per-profile image and resource overrides', () => {
    const { argv } = build(cwd, { container: { image: 'ghcr.io/acme/verify:2', memoryMb: 4096, cpus: 1.5, pidsLimit: 128 } });
    expect(argv[argv.length - 4]).toBe('ghcr.io/acme/verify:2');
    expect(flagValue(argv, '--memory')).toBe('4096m');
    expect(flagValue(argv, '--cpus')).toBe('1.5');
    expect(flagValue(argv, '--pids-limit')).toBe('128');
  });

  it('falls back to the default image for a blank override', () => {
    const { argv } = build(cwd, { container: { image: '   ' } });
    expect(argv[argv.length - 4]).toBe(DEFAULT_CREW_CONTAINER_IMAGE);
  });

  it('bind-mounts the workspace read-write at /workspace and sets it as the workdir', () => {
    const { argv } = build(cwd);
    expect(argv).toContain(`type=bind,src=${cwd},dst=/workspace`);
    expect(flagValue(argv, '--workdir')).toBe('/workspace');
  });

  it('mounts a dependency root read-only at /nuncio-deps when provided', () => {
    const deps = realpathSync.native(mkdtempSync(join(tmpdir(), 'crew-container-deps-')));
    try {
      const { argv } = build(cwd, { dependencyRoot: deps });
      expect(argv).toContain(`type=bind,src=${deps},dst=/nuncio-deps,readonly`);
    } finally {
      rmSync(deps, { recursive: true, force: true });
    }
  });

  it('omits the dependency mount when no dependency root is provided', () => {
    const { argv } = build(cwd);
    expect(argv.some((arg) => arg.includes('/nuncio-deps'))).toBe(false);
  });

  it('rejects a dependency root that is not a directory', () => {
    const file = join(cwd, 'not-a-dir');
    writeFileSync(file, 'x');
    expect(() => build(cwd, { dependencyRoot: file })).toThrow('not a directory');
  });

  it('names each container uniquely so concurrent verifies never collide', () => {
    const a = build(cwd);
    const b = build(cwd);
    const nameA = flagValue(a.argv, '--name');
    const nameB = flagValue(b.argv, '--name');
    expect(nameA).toMatch(/^nuncio-crew-verify-/);
    expect(nameA).not.toBe(nameB);
  });

  it('exposes a best-effort teardown hook that does not throw', () => {
    const { onTerminate } = build(cwd);
    expect(typeof onTerminate).toBe('function');
    // The fake runtime binary does not exist; teardown must swallow the spawn failure.
    expect(() => onTerminate!()).not.toThrow();
  });
});

describe('containerCrewSandboxBackend', () => {
  it('registers under the container name', () => {
    expect(containerCrewSandboxBackend.name).toBe(CONTAINER_CREW_SANDBOX_BACKEND);
    expect(CONTAINER_CREW_SANDBOX_BACKEND).toBe('container');
  });
});
