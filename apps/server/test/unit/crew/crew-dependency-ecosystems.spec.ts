import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectCrewEcosystemDependencies,
} from '../../../src/crew/crew-dependency-ecosystems';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}
function makeDir(...parts: string[]): string {
  const dir = join(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function project(input: Parameters<typeof projectCrewEcosystemDependencies>[0]) {
  return projectCrewEcosystemDependencies({ worktrees: [], ...input });
}

describe('Crew per-ecosystem dependency projection', () => {
  describe('detection', () => {
    it('projects nothing for an unknown ecosystem (no marker files)', () => {
      const snapshot = scratch('crew-eco-unknown-');
      writeFileSync(join(snapshot, 'README.md'), 'no dependencies here');
      const result = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: scratch('crew-eco-home-'), env: {} });
      expect(result.mounts).toEqual([]);
      expect(result.dependencyRoot).toBeNull();
    });

    it('detects go, rust, and python only from their own lockfile markers', () => {
      const home = scratch('crew-eco-home-');
      makeDir(home, 'go/pkg/mod');
      makeDir(home, '.cargo/registry');
      const goSnap = scratch('crew-eco-go-');
      writeFileSync(join(goSnap, 'go.sum'), 'h1:...\n');
      const rustSnap = scratch('crew-eco-rust-');
      writeFileSync(join(rustSnap, 'Cargo.lock'), '[[package]]\n');
      expect(project({ snapshotPath: goSnap, sourcePath: goSnap, homeDir: home, env: {}, platform: 'linux' })
        .mounts.map((m) => m.guestPath)).toEqual(['/nuncio-go-mod']);
      expect(project({ snapshotPath: rustSnap, sourcePath: rustSnap, homeDir: home, env: {}, platform: 'linux' })
        .mounts.map((m) => m.guestPath)).toEqual(['/nuncio-cargo/registry']);
    });
  });

  describe('go', () => {
    it('mounts the default GOMODCACHE read-only with offline env on both platforms', () => {
      const home = scratch('crew-eco-home-');
      const cache = realpathSync.native(makeDir(home, 'go/pkg/mod'));
      const snapshot = scratch('crew-eco-go-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');

      const linux = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'linux' });
      expect(linux.mounts).toEqual([{
        hostPath: cache, guestPath: '/nuncio-go-mod', pathPrepend: [],
        env: { GOMODCACHE: '/nuncio-go-mod', GOFLAGS: '-mod=readonly', GOPROXY: 'off', GOTOOLCHAIN: 'local' },
      }]);

      const mac = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'darwin' });
      expect(mac.mounts[0]!.env.GOMODCACHE).toBe(cache);
      expect(mac.mounts[0]!.hostPath).toBe(cache);
    });

    it('honors a $GOMODCACHE override and $GOPATH before the home default', () => {
      const home = scratch('crew-eco-home-');
      const override = realpathSync.native(scratch('crew-eco-gomodcache-'));
      const gopath = scratch('crew-eco-gopath-');
      const gopathCache = realpathSync.native(makeDir(gopath, 'pkg/mod'));
      const snapshot = scratch('crew-eco-go-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');

      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, platform: 'linux',
        env: { GOMODCACHE: override } }).mounts[0]!.hostPath).toBe(override);
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, platform: 'linux',
        env: { GOPATH: gopath } }).mounts[0]!.hostPath).toBe(gopathCache);
    });

    it('falls back to no projection when the module cache is absent', () => {
      const snapshot = scratch('crew-eco-go-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: scratch('crew-eco-home-'), env: {} })
        .mounts).toEqual([]);
    });
  });

  describe('rust', () => {
    it('mounts only CARGO_HOME/registry read-only with a writable CARGO_HOME', () => {
      const home = scratch('crew-eco-home-');
      const registry = realpathSync.native(makeDir(home, '.cargo/registry'));
      const cargoHome = realpathSync.native(join(home, '.cargo'));
      const snapshot = scratch('crew-eco-rust-');
      writeFileSync(join(snapshot, 'Cargo.lock'), '[[package]]\n');

      const linux = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'linux' });
      expect(linux.mounts).toEqual([{
        hostPath: registry, guestPath: '/nuncio-cargo/registry', writableGuestParent: '/nuncio-cargo',
        pathPrepend: [], env: { CARGO_HOME: '/nuncio-cargo', CARGO_NET_OFFLINE: 'true' },
      }]);

      const mac = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'darwin' });
      expect(mac.mounts[0]!.env.CARGO_HOME).toBe(cargoHome);
      expect(mac.mounts[0]!.hostPath).toBe(registry);
    });

    it('honors a $CARGO_HOME override', () => {
      const override = scratch('crew-eco-cargo-');
      const registry = realpathSync.native(makeDir(override, 'registry'));
      const snapshot = scratch('crew-eco-rust-');
      writeFileSync(join(snapshot, 'Cargo.lock'), '[[package]]\n');
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: scratch('crew-eco-home-'),
        platform: 'linux', env: { CARGO_HOME: override } }).mounts[0]!.hostPath).toBe(registry);
    });

    it('falls back to no projection when the registry cache is absent', () => {
      const home = scratch('crew-eco-home-');
      makeDir(home, '.cargo'); // CARGO_HOME exists but has no registry subdirectory
      const snapshot = scratch('crew-eco-rust-');
      writeFileSync(join(snapshot, 'Cargo.lock'), '[[package]]\n');
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {} }).mounts).toEqual([]);
    });
  });

  describe('python', () => {
    it('mounts a source-worktree venv read-only and prepends its bin to PATH', () => {
      const source = scratch('crew-eco-py-src-');
      makeDir(source, '.venv/bin');
      const venv = realpathSync.native(join(source, '.venv'));
      writeFileSync(join(source, 'poetry.lock'), '# lock\n');

      const linux = project({ snapshotPath: source, sourcePath: source, homeDir: scratch('crew-eco-home-'), env: {}, platform: 'linux' });
      expect(linux.mounts).toEqual([{
        hostPath: venv, guestPath: '/nuncio-venv', pathPrepend: ['/nuncio-venv/bin'],
        env: { VIRTUAL_ENV: '/nuncio-venv', PYTHONDONTWRITEBYTECODE: '1' },
      }]);

      const mac = project({ snapshotPath: source, sourcePath: source, homeDir: scratch('crew-eco-home-'), env: {}, platform: 'darwin' });
      expect(mac.mounts[0]!.env.VIRTUAL_ENV).toBe(venv);
      expect(mac.mounts[0]!.pathPrepend).toEqual([join(venv, 'bin')]);
    });

    it('detects uv.lock and honors a $VIRTUAL_ENV override', () => {
      const override = scratch('crew-eco-venv-');
      makeDir(override, 'bin');
      const snapshot = scratch('crew-eco-py-');
      writeFileSync(join(snapshot, 'uv.lock'), 'version = 1\n');
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: scratch('crew-eco-home-'),
        platform: 'linux', env: { VIRTUAL_ENV: override } }).mounts[0]!.hostPath)
        .toBe(realpathSync.native(override));
    });

    it('falls back when the venv is absent or lacks a bin directory', () => {
      const source = scratch('crew-eco-py-src-');
      writeFileSync(join(source, 'poetry.lock'), '# lock\n');
      expect(project({ snapshotPath: source, sourcePath: source, homeDir: scratch('crew-eco-home-'), env: {} }).mounts)
        .toEqual([]);
      makeDir(source, '.venv'); // exists but no bin/ -> not a real environment
      expect(project({ snapshotPath: source, sourcePath: source, homeDir: scratch('crew-eco-home-'), env: {} }).mounts)
        .toEqual([]);
    });
  });

  describe('multi-ecosystem and edge cases', () => {
    it('projects every detected ecosystem with distinct guest mount paths', () => {
      const home = scratch('crew-eco-home-');
      makeDir(home, 'go/pkg/mod');
      makeDir(home, '.cargo/registry');
      const source = scratch('crew-eco-multi-');
      makeDir(source, '.venv/bin');
      writeFileSync(join(source, 'go.sum'), 'h1:abc\n');
      writeFileSync(join(source, 'Cargo.lock'), '[[package]]\n');
      writeFileSync(join(source, 'uv.lock'), 'version = 1\n');

      const guestPaths = project({ snapshotPath: source, sourcePath: source, homeDir: home, env: {}, platform: 'linux' })
        .mounts.map((m) => m.guestPath);
      expect(guestPaths).toEqual(['/nuncio-go-mod', '/nuncio-cargo/registry', '/nuncio-venv']);
      expect(new Set(guestPaths).size).toBe(guestPaths.length);
    });

    it('treats a non-directory cache path as absent (fallback, not a mount)', () => {
      const home = scratch('crew-eco-home-');
      writeFileSync(join(home, 'go-mod-file'), 'not a directory');
      const snapshot = scratch('crew-eco-go-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, platform: 'linux',
        env: { GOMODCACHE: join(home, 'go-mod-file') } }).mounts).toEqual([]);
    });

    it('does not throw when a JS store is absent alongside a non-JS ecosystem', () => {
      const home = scratch('crew-eco-home-');
      makeDir(home, 'go/pkg/mod');
      const snapshot = scratch('crew-eco-go-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');
      const result = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'linux' });
      expect(result.dependencyRoot).toBeNull();
      expect(result.mounts).toHaveLength(1);
      expect(existsSync(snapshot)).toBe(true);
    });
  });
});
