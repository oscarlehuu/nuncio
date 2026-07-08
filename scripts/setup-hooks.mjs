import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  console.log('Configured git hooks path: .githooks');
} catch (err) {
  console.error('Failed to configure git hooks. Run this inside the Nuncio git checkout.');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
