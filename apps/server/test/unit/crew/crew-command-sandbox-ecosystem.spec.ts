import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCrewSandboxLaunch, type CrewDependencyMount,
} from '../../../src/crew/crew-command-sandbox';
import { CrewCommandRunner } from '../../../src/crew/crew-command.runner';

const cleanups: string[] = [];
afterEach(() => { while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true }); });

function dir(prefix: string): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(path);
  return path;
}
function launch(platform: 'darwin' | 'linux', mounts: CrewDependencyMount[]) {
  const result = buildCrewSandboxLaunch('true', process.cwd(), platform, '/usr/bin/true', {
    dependencyMounts: mounts,
  });
  cleanups.push(result.tempDir);
  return result;
}
// Extract consecutive `--setenv KEY VALUE` triples from a bubblewrap argv.
function linuxSetenv(argv: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length - 2; i += 1) {
    if (argv[i] === '--setenv') env[argv[i + 1]!] = argv[i + 2]!;
  }
  return env;
}
function hasTriple(argv: string[], a: string, b: string, c: string): boolean {
  return argv.some((_, i) => argv[i] === a && argv[i + 1] === b && argv[i + 2] === c);
}

describe('Crew sandbox per-ecosystem dependency mounts', () => {
  it('binds a Go module cache read-only in both profiles and points GOMODCACHE at it', () => {
    const cache = dir('crew-sandbox-go-');
    const goMac: CrewDependencyMount = {
      hostPath: cache, guestPath: '/nuncio-go-mod', pathPrepend: [],
      env: { GOMODCACHE: cache, GOFLAGS: '-mod=readonly' },
    };
    const mac = launch('darwin', [goMac]);
    const profile = mac.argv[2]!;
    expect(profile).toContain(`(require-not (subpath ${JSON.stringify(cache)}))`); // readable
    expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(cache)}))`); // never writable
    expect(mac.env.GOMODCACHE).toBe(cache);
    expect(mac.env.GOFLAGS).toBe('-mod=readonly');

    const goLinux: CrewDependencyMount = { ...goMac, env: { GOMODCACHE: '/nuncio-go-mod', GOFLAGS: '-mod=readonly' } };
    const linux = launch('linux', [goLinux]);
    expect(hasTriple(linux.argv, '--ro-bind', cache, '/nuncio-go-mod')).toBe(true);
    expect(hasTriple(linux.argv, '--bind', cache, '/nuncio-go-mod')).toBe(false); // not writable
    // Mount point created on the tmpfs root before the read-only bind, matching the JS store.
    const goDir = linux.argv.findIndex((a, i) => a === '--dir' && linux.argv[i + 1] === '/nuncio-go-mod');
    const goBind = linux.argv.findIndex((a, i) =>
      a === '--ro-bind' && linux.argv[i + 1] === cache && linux.argv[i + 2] === '/nuncio-go-mod');
    expect(goDir).toBeGreaterThanOrEqual(0);
    expect(goBind).toBeGreaterThan(goDir);
    expect(linuxSetenv(linux.argv).GOMODCACHE).toBe('/nuncio-go-mod');
  });

  it('binds a Cargo registry read-only under a writable CARGO_HOME on Linux', () => {
    const registry = dir('crew-sandbox-cargo-');
    const rust: CrewDependencyMount = {
      hostPath: registry, guestPath: '/nuncio-cargo/registry', writableGuestParent: '/nuncio-cargo',
      pathPrepend: [], env: { CARGO_HOME: '/nuncio-cargo', CARGO_NET_OFFLINE: 'true' },
    };
    const linux = launch('linux', [rust]);
    const dirIndex = linux.argv.findIndex((a, i) => a === '--dir' && linux.argv[i + 1] === '/nuncio-cargo');
    const bindIndex = linux.argv.findIndex((a, i) =>
      a === '--ro-bind' && linux.argv[i + 1] === registry && linux.argv[i + 2] === '/nuncio-cargo/registry');
    expect(dirIndex).toBeGreaterThanOrEqual(0);
    expect(bindIndex).toBeGreaterThan(dirIndex); // writable parent created before the read-only bind
    expect(linuxSetenv(linux.argv).CARGO_HOME).toBe('/nuncio-cargo');
    expect(linuxSetenv(linux.argv).CARGO_NET_OFFLINE).toBe('true');

    const mac = launch('darwin', [{ ...rust, env: { CARGO_HOME: registry, CARGO_NET_OFFLINE: 'true' } }]);
    expect(mac.argv[2]!).toContain(`(deny file-write* (subpath ${JSON.stringify(registry)}))`);
  });

  it('prepends the venv bin to PATH and mounts the venv read-only', () => {
    const venv = dir('crew-sandbox-venv-');
    const macMount: CrewDependencyMount = {
      hostPath: venv, guestPath: '/nuncio-venv', pathPrepend: [join(venv, 'bin')],
      env: { VIRTUAL_ENV: venv },
    };
    const mac = launch('darwin', [macMount]);
    expect(mac.env.PATH.split(':')[0]).toBe(join(venv, 'bin'));
    expect(mac.env.VIRTUAL_ENV).toBe(venv);
    expect(mac.argv[2]!).toContain(`(deny file-write* (subpath ${JSON.stringify(venv)}))`);

    const linux = launch('linux', [{
      ...macMount, pathPrepend: ['/nuncio-venv/bin'], env: { VIRTUAL_ENV: '/nuncio-venv' },
    }]);
    expect(linuxSetenv(linux.argv).PATH.split(':')[0]).toBe('/nuncio-venv/bin');
    expect(hasTriple(linux.argv, '--ro-bind', venv, '/nuncio-venv')).toBe(true);
  });

  it('projects multiple ecosystems side by side without weakening deny-by-default', () => {
    const goCache = dir('crew-sandbox-go-');
    const registry = dir('crew-sandbox-cargo-');
    const mounts: CrewDependencyMount[] = [
      { hostPath: goCache, guestPath: '/nuncio-go-mod', pathPrepend: [], env: { GOMODCACHE: '/nuncio-go-mod' } },
      {
        hostPath: registry, guestPath: '/nuncio-cargo/registry', writableGuestParent: '/nuncio-cargo',
        pathPrepend: [], env: { CARGO_HOME: '/nuncio-cargo' },
      },
    ];
    const linux = launch('linux', mounts);
    expect(hasTriple(linux.argv, '--ro-bind', goCache, '/nuncio-go-mod')).toBe(true);
    expect(hasTriple(linux.argv, '--ro-bind', registry, '/nuncio-cargo/registry')).toBe(true);
    // Isolation flags untouched: no network, cleared env, fresh session.
    expect(linux.argv).toEqual(expect.arrayContaining(['--unshare-all', '--clearenv', '--new-session']));

    const mac = launch('darwin', mounts);
    const profile = mac.argv[2]!;
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny file-read-data (require-all (subpath "/")'); // global default-deny intact
    for (const cache of [goCache, registry]) {
      expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(cache)}))`);
    }
  });

  it('fails closed when a declared mount is not a directory', () => {
    const missing = join(tmpdir(), `crew-sandbox-missing-${process.pid}`);
    expect(() => buildCrewSandboxLaunch('true', process.cwd(), 'linux', '/usr/bin/true', {
      dependencyMounts: [{ hostPath: missing, guestPath: '/nuncio-go-mod', pathPrepend: [], env: {} }],
    })).toThrow();
  });

  // Proves the host OS actually enforces the contract (Seatbelt or bubblewrap), not just that the
  // launch args are shaped right: a projected cache is readable but a write into it is denied.
  it('enforces the projected cache read-only inside the real sandbox', async () => {
    const cache = dir('crew-sandbox-live-');
    writeFileSync(join(cache, 'module.txt'), 'cached-module');
    const guest = process.platform === 'linux' ? '/nuncio-go-mod' : cache;
    const mount: CrewDependencyMount = {
      hostPath: cache, guestPath: '/nuncio-go-mod', pathPrepend: [], env: { GOMODCACHE: guest },
    };
    const runner = new CrewCommandRunner();
    const workspace = dir('crew-sandbox-live-ws-');
    const read = await runner.run(
      'cat "$GOMODCACHE/module.txt"', workspace, 2000, undefined, undefined, { dependencyMounts: [mount] },
    );
    expect(read).toMatchObject({ exitCode: 0, spawnError: null });
    expect(read.stdout).toBe('cached-module');

    const write = await runner.run(
      'printf x > "$GOMODCACHE/intrude"', workspace, 2000, undefined, undefined, { dependencyMounts: [mount] },
    );
    expect(write.exitCode).not.toBe(0);
    expect(existsSync(join(cache, 'intrude'))).toBe(false);
  });
});
