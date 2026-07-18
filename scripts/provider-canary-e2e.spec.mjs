// End-to-end canary proof: `bun scripts/provider-canary.mjs --mock` must exit 0
// and report a PASS row for the mock provider. This exercises the WHOLE canary
// loop — hermetic daemon boot, provider discovery over HTTP, session create,
// terminal-status polling, event-shape verdict, report render — with zero
// credentials, so it is CI-runnable (part of `bun run test:scripts`). The same
// runner, minus --mock, is the local real-provider canary.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');

describe('provider canary (mock end-to-end)', () => {
  test(
    'mock canary passes and prints a PASS row',
    () => {
      const res = spawnSync('bun', ['scripts/provider-canary.mjs', '--mock'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(res.status, `canary failed:\n${res.stdout}\n${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('| mock |');
      expect(res.stdout).toContain('PASS');
      expect(res.stdout).not.toContain('FAIL');
    },
    120000,
  );

  test(
    'requesting an unavailable provider fails the run (a canary must never green while testing nothing)',
    () => {
      const res = spawnSync(
        'bun',
        ['scripts/provider-canary.mjs', '--mock', '--providers', 'no-such-engine'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('no-such-engine');
    },
    120000,
  );
});
