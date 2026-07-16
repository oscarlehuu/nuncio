import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
function makeDir(...parts: string[]): string {
  const path = join(...parts);
  mkdirSync(path, { recursive: true });
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

  it('binds a venv at its real path (so shebangs resolve), read-only, PATH-prepended', () => {
    const venv = dir('crew-sandbox-venv-');
    const mount: CrewDependencyMount = {
      hostPath: venv, guestPath: venv, pathPrepend: [join(venv, 'bin')],
      env: { VIRTUAL_ENV: venv },
    };
    const mac = launch('darwin', [mount]);
    expect(mac.env.PATH.split(':')[0]).toBe(join(venv, 'bin'));
    expect(mac.env.VIRTUAL_ENV).toBe(venv);
    expect(mac.argv[2]!).toContain(`(deny file-write* (subpath ${JSON.stringify(venv)}))`);

    const linux = launch('linux', [mount]);
    expect(linuxSetenv(linux.argv).PATH.split(':')[0]).toBe(join(venv, 'bin'));
    expect(linuxSetenv(linux.argv).VIRTUAL_ENV).toBe(venv);
    expect(hasTriple(linux.argv, '--ro-bind', venv, venv)).toBe(true);
    // An original-path bind (guestPath === hostPath) must NOT be `--dir`-ed: its parent may sit
    // under a read-only bind, and the mount point already exists / is auto-created with the bind.
    expect(linux.argv.findIndex((a, i) => a === '--dir' && linux.argv[i + 1] === venv)).toBe(-1);
  });

  it('binds a toolchain install root at its real path without a --dir', () => {
    const root = dir('crew-sandbox-toolchain-');
    const binDir = makeDir(root, 'bin');
    const mount: CrewDependencyMount = { hostPath: root, guestPath: root, pathPrepend: [binDir], env: {} };
    const linux = launch('linux', [mount]);
    expect(hasTriple(linux.argv, '--ro-bind', root, root)).toBe(true);
    expect(linux.argv.findIndex((a, i) => a === '--dir' && linux.argv[i + 1] === root)).toBe(-1);
    expect(linuxSetenv(linux.argv).PATH.split(':')[0]).toBe(binDir);
    const mac = launch('darwin', [mount]);
    expect(mac.env.PATH.split(':')[0]).toBe(binDir);
    expect(mac.argv[2]!).toContain(`(require-not (subpath ${JSON.stringify(root)}))`); // readable
  });

  it('carves a source-root venv out of the macOS source-root read-deny so it stays readable', () => {
    const source = dir('crew-sandbox-src-');
    const venv = realpathSync.native(makeDir(source, '.venv'));
    const mount: CrewDependencyMount = {
      hostPath: venv, guestPath: venv, pathPrepend: [join(venv, 'bin')], env: { VIRTUAL_ENV: venv },
    };
    const mac = buildCrewSandboxLaunch('true', process.cwd(), 'darwin', '/usr/bin/true', {
      sourceRoot: source, dependencyMounts: [mount],
    });
    cleanups.push(mac.tempDir);
    const profile = mac.argv[2]!;
    // The later source-root read-deny would otherwise win over the read-allow and nullify it; the
    // venv must be carved out with a require-not so it remains readable.
    expect(profile).toContain(
      `(deny file-read-data (require-all (subpath ${JSON.stringify(source)}) `
      + `(require-not (subpath ${JSON.stringify(venv)}))))`,
    );
    expect(profile).toContain(`(require-not (subpath ${JSON.stringify(venv)}))`); // in read roots
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
