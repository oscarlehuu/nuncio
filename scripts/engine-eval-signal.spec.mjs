// Signal-hygiene proof: a SIGTERM (CI timeout / Ctrl-C) mid-run must tear the
// hermetic daemon and tmp dirs down, not orphan a nuncio process or leak
// nuncio-hermetic-* / nuncio-eval-* dirs. We spawn the real runner, wait until
// its daemon has booted (a nuncio-hermetic-* tmp dir appears), SIGTERM it, then
// assert clean teardown. Runs under `bun run test:scripts` from the repo root.
import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const TMP = tmpdir();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalTmpDirs = () =>
  readdirSync(TMP).filter((n) => n.startsWith('nuncio-hermetic-') || n.startsWith('nuncio-eval-'));

async function waitFor(fn, { timeout = 15000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

describe('engine-eval SIGTERM hygiene', () => {
  test(
    'a SIGTERM mid-run tears down the daemon and tmp dirs, no orphans',
    async () => {
      const before = new Set(evalTmpDirs());

      const child = spawn(
        'bun',
        ['scripts/engine-eval.mjs', '--engines', 'mock', '--tasks', 'smoke-mock-echo'],
        { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const logs = [];
      child.stdout.on('data', (b) => logs.push(b.toString()));
      child.stderr.on('data', (b) => logs.push(b.toString()));

      const exited = new Promise((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal })),
      );

      // Wait until the daemon has booted (a fresh hermetic tmp dir exists).
      const booted = await waitFor(() => evalTmpDirs().some((d) => !before.has(d)));
      expect(booted, `daemon never booted; logs:\n${logs.join('')}`).toBe(true);

      child.kill('SIGTERM');
      const { code } = await Promise.race([
        exited,
        waitFor(() => null, { timeout: 10000 }).then(() => ({ code: 'TIMEOUT' })),
      ]);
      expect(code, `runner did not exit after SIGTERM; logs:\n${logs.join('')}`).not.toBe('TIMEOUT');
      expect(code).not.toBe(0); // signal path exits non-zero

      // Give the teardown a beat to finish removing the temp dir.
      await sleep(500);

      // No fresh eval/hermetic tmp dirs left behind by THIS run.
      const leaked = evalTmpDirs().filter((d) => !before.has(d));
      expect(leaked, `leaked tmp dirs: ${leaked.join(', ')}`).toEqual([]);

      // No orphaned daemon process.
      const ps = spawnSync('pgrep', ['-f', 'apps/server/src/main.ts'], { encoding: 'utf8' });
      expect(ps.stdout.trim(), `orphan daemon pids: ${ps.stdout}`).toBe('');
    },
    30000,
  );
});
