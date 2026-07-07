// Solvability + hidden-check-fidelity proof for the eval task batch. Since no
// real engine runs in CI, this IS the batch's verification bar: for each task,
//   1. build the fixture in a tmp repo,
//   2. assert the visible verifyCommand FAILS on the untouched fixture (the task
//      genuinely requires a change; for follow-output-contract the initial state
//      simply lacks reports/audit.json, same red signal),
//   3. apply reference-solution.patch (+ a scripted commit where the hidden check
//      requires one) → verifyCommand exits 0 AND the hidden check passes,
//   4. where an anti-gaming layer exists, apply reference-violation.patch and
//      assert the hidden check FAILS.
// Runs from the repo root via `bun run test:scripts`.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(repoRoot, 'eval', 'fixtures');
const tasksDir = join(repoRoot, 'eval', 'tasks');
const checksDir = join(repoRoot, 'eval', 'checks');

function sh(dir, cmd) {
  return spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}
function git(dir, args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}
function applyPatch(dir, patchPath) {
  const res = spawnSync('git', ['apply', patchPath], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  if (res.status !== 0) throw new Error(`git apply ${patchPath} failed: ${res.stderr}`);
}

async function loadTask(id) {
  const raw = await Bun.file(join(tasksDir, `${id}.json`)).text();
  return JSON.parse(raw);
}
async function buildFixture(fixtureId) {
  const { setup } = await import(join(fixturesDir, fixtureId, 'setup.mjs'));
  const dir = await mkdtemp(join(tmpdir(), `solv-${fixtureId}-`));
  await setup(dir);
  return dir;
}
async function runHidden(taskId, ctx) {
  const mod = await import(join(checksDir, `${taskId}.mjs`));
  return (mod.default ?? mod.check)(ctx);
}
const synthEvents = [{ type: 'assistant_message', payload: { text: 'done' } }];

// Tasks that need a commit made after applying the solution (conventional-commit
// asserts on the commit). The message is a valid conventional-commit subject.
const COMMIT_AFTER = {
  'conventional-commit': 'fix: add global flag so slugify replaces every space',
};

// `visibleRed`: does the visible verifyCommand FAIL on the untouched fixture?
// True for tasks whose starting state is broken (a failing test / non-compiling
// code / a missing deliverable). False for tasks whose visible suite is green at
// HEAD by design (rename must KEEP tests green) — for those the untouched signal
// lives in the hidden layer, which we assert fails on the pristine fixture.
const TASKS = [
  { id: 'fix-failing-unit-test', fixture: 'ts-lib-broken-slugify', visibleRed: true },
  { id: 'implement-function-from-spec', fixture: 'ts-lib-interval-merge', visibleRed: true },
  { id: 'rename-across-files', fixture: 'ts-lib-rename-fetchuser', visibleRed: false },
  { id: 'adapt-to-changed-api', fixture: 'ts-lib-logger-migration', visibleRed: true },
  { id: 'respect-do-not-touch', fixture: 'ts-lib-frozen-config', visibleRed: true },
  { id: 'follow-output-contract', fixture: 'ts-lib-audit-target', visibleRed: true },
  { id: 'conventional-commit', fixture: 'ts-lib-broken-slugify', visibleRed: true },
  { id: 'scoped-diff-budget', fixture: 'ts-lib-off-by-one', visibleRed: true },
];

describe('eval task batch — solvability + hidden-check fidelity', () => {
  for (const { id, fixture, visibleRed } of TASKS) {
    test(`${id}: red on untouched, green + hidden-pass after the reference solution`, async () => {
      const task = await loadTask(id);
      const dir = await buildFixture(fixture);
      try {
        // 2. The untouched fixture must be RED. For most tasks that is the
        // visible verify failing; for the rename task the visible suite is green
        // at HEAD by design, so the red signal is its hidden check failing on the
        // pristine fixture (the rename is not yet done).
        if (visibleRed) {
          const before = sh(dir, task.verifyCommand);
          expect(before.status, `${id}: verify unexpectedly passed on the untouched fixture`).not.toBe(0);
        } else {
          const before = sh(dir, task.verifyCommand);
          expect(before.status, `${id}: expected the visible suite green at HEAD`).toBe(0);
          const hiddenBefore = await runHidden(id, { fixtureDir: dir, taskDto: { status: 'DONE' }, sessionEvents: synthEvents });
          expect(hiddenBefore.pass, `${id}: hidden check unexpectedly passed on the untouched fixture`).toBe(false);
        }

        // 3. apply the correct solution.
        applyPatch(dir, join(fixturesDir, fixture, 'reference-solution.patch'));
        if (COMMIT_AFTER[id]) {
          git(dir, ['add', '-A']);
          const c = git(dir, ['commit', '--no-verify', '-m', COMMIT_AFTER[id]]);
          expect(c.status, `${id}: scripted commit failed: ${c.stderr}`).toBe(0);
        }

        const after = sh(dir, task.verifyCommand);
        expect(after.status, `${id}: verify failed after the reference solution:\n${after.stdout}\n${after.stderr}`).toBe(0);

        const hidden = await runHidden(id, { fixtureDir: dir, taskDto: { status: 'DONE' }, sessionEvents: synthEvents });
        expect(hidden.pass, `${id}: hidden check rejected a correct solution: ${hidden.notes.join('; ')}`).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test(`${id}: hidden check rejects the reference violation (if one exists)`, async () => {
      const violationPatch = join(fixturesDir, fixture, 'reference-violation.patch');
      if (!existsSync(violationPatch)) {
        // Not every task has an anti-gaming layer; skip cleanly.
        return;
      }
      const task = await loadTask(id);
      const dir = await buildFixture(fixture);
      try {
        applyPatch(dir, violationPatch);
        if (COMMIT_AFTER[id]) {
          git(dir, ['add', '-A']);
          git(dir, ['commit', '--no-verify', '-m', COMMIT_AFTER[id]]);
        }
        // The violation may or may not pass the visible verify; what matters is
        // the HIDDEN layer catches it.
        const hidden = await runHidden(id, { fixtureDir: dir, taskDto: { status: 'DONE' }, sessionEvents: synthEvents });
        expect(hidden.pass, `${id}: hidden check accepted a violating solution: ${hidden.notes.join('; ')}`).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
