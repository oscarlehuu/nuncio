import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectCrewEcosystemDependencies,
} from '../../../src/crew/crew-dependency-ecosystems';

type WhichFn = (bin: string) => string | null;

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
// A toolchain installed OUTSIDE the sandbox-denied home (a distinct scratch dir), so it is
// projectable. `root` is the install root that gets mounted, `binDir` the PATH entry.
function fakeToolchain(name: string): { which: WhichFn; root: string; binDir: string } {
  const root = scratch(`crew-eco-tc-${name}-`);
  makeDir(root, 'bin');
  const bin = join(root, 'bin', name);
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  return { which: (b) => (b === name ? bin : null), root, binDir: join(root, 'bin') };
}
function project(input: Parameters<typeof projectCrewEcosystemDependencies>[0]) {
  return projectCrewEcosystemDependencies({ worktrees: [], which: () => null, ...input });
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
  });

  describe('go', () => {
    it('mounts the module cache and the go toolchain when both are reachable', () => {
      const home = scratch('crew-eco-home-');
      const cache = realpathSync.native(makeDir(home, 'go/pkg/mod'));
      const go = fakeToolchain('go');
      const snapshot = scratch('crew-eco-go-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');

      const linux = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'linux', which: go.which });
      expect(linux.mounts).toEqual([
        {
          hostPath: cache, guestPath: '/nuncio-go-mod', pathPrepend: [],
          env: { GOMODCACHE: '/nuncio-go-mod', GOFLAGS: '-mod=readonly', GOPROXY: 'off', GOTOOLCHAIN: 'local' },
        },
        { hostPath: go.root, guestPath: go.root, pathPrepend: [go.binDir], env: {} },
      ]);

      const mac = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'darwin', which: go.which });
      expect(mac.mounts[0]!.env.GOMODCACHE).toBe(cache);
    });

    it('skips when the go toolchain is absent or installed under the denied home', () => {
      const home = scratch('crew-eco-home-');
      makeDir(home, 'go/pkg/mod');
      const snapshot = scratch('crew-eco-go-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');
      // Absent toolchain.
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, which: () => null }).mounts)
        .toEqual([]);
      // Home-installed toolchain (rustup/mise shape) is unreachable in the home-denied sandbox.
      makeDir(home, '.local/bin');
      const homeGo = join(home, '.local/bin/go');
      writeFileSync(homeGo, '#!/bin/sh\n', { mode: 0o755 });
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, which: () => homeGo }).mounts)
        .toEqual([]);
    });

    it('honors $GOMODCACHE and $GOPATH and falls back when the cache is absent', () => {
      const home = scratch('crew-eco-home-');
      const go = fakeToolchain('go');
      const override = realpathSync.native(scratch('crew-eco-gomodcache-'));
      const gopath = scratch('crew-eco-gopath-');
      const gopathCache = realpathSync.native(makeDir(gopath, 'pkg/mod'));
      const snapshot = scratch('crew-eco-go-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');

      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, platform: 'linux',
        env: { GOMODCACHE: override }, which: go.which }).mounts[0]!.hostPath).toBe(override);
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, platform: 'linux',
        env: { GOPATH: gopath }, which: go.which }).mounts[0]!.hostPath).toBe(gopathCache);
      // Reachable toolchain but no module cache -> no projection (uncached install fails closed).
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, which: go.which }).mounts)
        .toEqual([]);
    });
  });

  describe('rust', () => {
    it('mounts registry read-only inside a writable CARGO_HOME plus the cargo toolchain', () => {
      const home = scratch('crew-eco-home-');
      const registry = realpathSync.native(makeDir(home, '.cargo/registry'));
      const cargoHome = realpathSync.native(join(home, '.cargo'));
      const cargo = fakeToolchain('cargo');
      const snapshot = scratch('crew-eco-rust-');
      writeFileSync(join(snapshot, 'Cargo.lock'), '[[package]]\nname = "x"\n');

      const linux = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'linux', which: cargo.which });
      expect(linux.mounts).toEqual([
        {
          hostPath: registry, guestPath: '/nuncio-cargo/registry', writableGuestParent: '/nuncio-cargo',
          pathPrepend: [], env: { CARGO_HOME: '/nuncio-cargo', CARGO_NET_OFFLINE: 'true' },
        },
        { hostPath: cargo.root, guestPath: cargo.root, pathPrepend: [cargo.binDir], env: {} },
      ]);

      const mac = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'darwin', which: cargo.which });
      expect(mac.mounts[0]!.env.CARGO_HOME).toBe(cargoHome);
    });

    it('mounts $CARGO_HOME/git when Cargo.lock has git sources, and skips when git cache is missing', () => {
      const home = scratch('crew-eco-home-');
      makeDir(home, '.cargo/registry');
      const gitCache = realpathSync.native(makeDir(home, '.cargo/git'));
      const cargo = fakeToolchain('cargo');
      const snapshot = scratch('crew-eco-rust-');
      writeFileSync(join(snapshot, 'Cargo.lock'),
        '[[package]]\nname = "x"\nsource = "git+https://github.com/a/b#deadbeef"\n');

      const withGit = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'linux', which: cargo.which });
      expect(withGit.mounts.map((m) => m.guestPath)).toContain('/nuncio-cargo/git');
      expect(withGit.mounts.find((m) => m.guestPath === '/nuncio-cargo/git')!.hostPath).toBe(gitCache);

      // Same git-source lock, but the git cache is absent -> do not claim a Rust projection.
      const home2 = scratch('crew-eco-home-');
      makeDir(home2, '.cargo/registry');
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home2, env: {}, platform: 'linux', which: cargo.which }).mounts)
        .toEqual([]);
    });

    it('skips when cargo or the registry is absent', () => {
      const home = scratch('crew-eco-home-');
      makeDir(home, '.cargo'); // no registry subdir
      const cargo = fakeToolchain('cargo');
      const snapshot = scratch('crew-eco-rust-');
      writeFileSync(join(snapshot, 'Cargo.lock'), '[[package]]\n');
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, which: cargo.which }).mounts).toEqual([]);
      makeDir(home, '.cargo/registry');
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, which: () => null }).mounts).toEqual([]);
    });
  });

  describe('python', () => {
    it('borrows only a venv whose worktree lockfile bytes match the snapshot, bound at its real path', () => {
      const source = scratch('crew-eco-py-src-');
      makeDir(source, '.venv/bin');
      const venv = realpathSync.native(join(source, '.venv'));
      writeFileSync(join(source, 'poetry.lock'), 'LOCK-A\n');
      const snapshot = scratch('crew-eco-py-snap-');
      writeFileSync(join(snapshot, 'poetry.lock'), 'LOCK-A\n');

      const result = project({ snapshotPath: snapshot, sourcePath: source, homeDir: scratch('crew-eco-home-'), env: {}, platform: 'linux' });
      expect(result.mounts).toEqual([{
        hostPath: venv, guestPath: venv, pathPrepend: [join(venv, 'bin')],
        env: { VIRTUAL_ENV: venv, PYTHONDONTWRITEBYTECODE: '1' },
      }]);
    });

    it('never borrows a venv whose lockfile bytes differ (no false gate evidence)', () => {
      const source = scratch('crew-eco-py-src-');
      makeDir(source, '.venv/bin');
      writeFileSync(join(source, 'poetry.lock'), 'LOCK-B\n');
      const snapshot = scratch('crew-eco-py-snap-');
      writeFileSync(join(snapshot, 'poetry.lock'), 'LOCK-A\n');
      expect(project({ snapshotPath: snapshot, sourcePath: source, homeDir: scratch('crew-eco-home-'), env: {} }).mounts)
        .toEqual([]);
    });

    it('ignores an ambient $VIRTUAL_ENV that no matched worktree backs', () => {
      const ambient = scratch('crew-eco-venv-');
      makeDir(ambient, 'bin');
      const source = scratch('crew-eco-py-src-'); // worktree has the lock but no .venv
      writeFileSync(join(source, 'uv.lock'), 'version = 1\n');
      const snapshot = scratch('crew-eco-py-snap-');
      writeFileSync(join(snapshot, 'uv.lock'), 'version = 1\n');
      expect(project({ snapshotPath: snapshot, sourcePath: source, homeDir: scratch('crew-eco-home-'),
        env: { VIRTUAL_ENV: ambient } }).mounts).toEqual([]);
    });

    it('detects uv.lock and matches a venv in a sibling worktree', () => {
      const provider = scratch('crew-eco-py-provider-');
      makeDir(provider, '.venv/bin');
      const venv = realpathSync.native(join(provider, '.venv'));
      writeFileSync(join(provider, 'uv.lock'), 'version = 1\n');
      const source = scratch('crew-eco-py-src-'); // the verified worktree, no venv
      const snapshot = scratch('crew-eco-py-snap-');
      writeFileSync(join(snapshot, 'uv.lock'), 'version = 1\n');
      expect(project({ snapshotPath: snapshot, sourcePath: source, worktrees: [provider],
        homeDir: scratch('crew-eco-home-'), env: {} }).mounts[0]!.hostPath).toBe(venv);
    });

    it('falls back when the venv lacks a bin directory', () => {
      const source = scratch('crew-eco-py-src-');
      makeDir(source, '.venv'); // no bin/
      writeFileSync(join(source, 'poetry.lock'), 'LOCK-A\n');
      const snapshot = scratch('crew-eco-py-snap-');
      writeFileSync(join(snapshot, 'poetry.lock'), 'LOCK-A\n');
      expect(project({ snapshotPath: snapshot, sourcePath: source, homeDir: scratch('crew-eco-home-'), env: {} }).mounts)
        .toEqual([]);
    });
  });

  describe('multi-ecosystem and edge cases', () => {
    it('projects every detected ecosystem with reachable toolchains', () => {
      const home = scratch('crew-eco-home-');
      makeDir(home, 'go/pkg/mod');
      makeDir(home, '.cargo/registry');
      const go = fakeToolchain('go');
      const cargo = fakeToolchain('cargo');
      const which: WhichFn = (b) => go.which(b) ?? cargo.which(b);
      const source = scratch('crew-eco-multi-');
      makeDir(source, '.venv/bin');
      writeFileSync(join(source, 'go.sum'), 'h1:abc\n');
      writeFileSync(join(source, 'Cargo.lock'), '[[package]]\n');
      writeFileSync(join(source, 'uv.lock'), 'version = 1\n');
      const snapshot = scratch('crew-eco-multi-snap-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');
      writeFileSync(join(snapshot, 'Cargo.lock'), '[[package]]\n');
      writeFileSync(join(snapshot, 'uv.lock'), 'version = 1\n');

      const guestPaths = project({ snapshotPath: snapshot, sourcePath: source, homeDir: home, env: {}, platform: 'linux', which })
        .mounts.map((m) => m.guestPath);
      expect(guestPaths).toContain('/nuncio-go-mod');
      expect(guestPaths).toContain('/nuncio-cargo/registry');
      expect(guestPaths).toContain(realpathSync.native(join(source, '.venv')));
    });

    it('treats a non-directory cache path as absent (fallback, not a mount)', () => {
      const home = scratch('crew-eco-home-');
      writeFileSync(join(home, 'go-mod-file'), 'not a directory');
      const go = fakeToolchain('go');
      const snapshot = scratch('crew-eco-go-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');
      expect(project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, platform: 'linux',
        env: { GOMODCACHE: join(home, 'go-mod-file') }, which: go.which }).mounts).toEqual([]);
    });

    it('does not throw when the JS store is absent alongside a non-JS ecosystem', () => {
      const home = scratch('crew-eco-home-');
      makeDir(home, 'go/pkg/mod');
      const go = fakeToolchain('go');
      const snapshot = scratch('crew-eco-go-');
      writeFileSync(join(snapshot, 'go.sum'), 'h1:abc\n');
      const result = project({ snapshotPath: snapshot, sourcePath: snapshot, homeDir: home, env: {}, platform: 'linux', which: go.which });
      expect(result.dependencyRoot).toBeNull();
      expect(result.mounts.length).toBe(2);
      expect(existsSync(snapshot)).toBe(true);
    });
  });
});
