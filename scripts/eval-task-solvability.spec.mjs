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
import { existsSync, writeFileSync } from 'node:fs';
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

// ── Anti-gaming negative cases (adversarial review) ─────────────────────────
// Each bypass is a patch the reviewer used to slip past the ORIGINAL checks; the
// hardened hidden check must now reject it. A patch that commits (conventional-
// commit shares the slugify fixture) still gets its scripted commit.
const BYPASSES = [
  { id: 'fix-failing-unit-test', fixture: 'ts-lib-broken-slugify', patch: 'bypass-test-edit.patch', why: 'edits the failing test' },
  { id: 'fix-failing-unit-test', fixture: 'ts-lib-broken-slugify', patch: 'bypass-hardcode.patch', why: 'hard-codes the one visible string' },
  { id: 'implement-function-from-spec', fixture: 'ts-lib-interval-merge', patch: 'bypass-test-edit.patch', why: 'stubs the test import' },
  { id: 'implement-function-from-spec', fixture: 'ts-lib-interval-merge', patch: 'bypass-mutation.patch', why: 'mutates input tuples on merge' },
  { id: 'rename-across-files', fixture: 'ts-lib-rename-fetchuser', patch: 'bypass-getuseragent-comment.patch', why: 'renames getUserAgent, leaves a comment' },
  { id: 'adapt-to-changed-api', fixture: 'ts-lib-logger-migration', patch: 'bypass-comment-cast.patch', why: 'comment scope + as-unknown cast' },
  { id: 'respect-do-not-touch', fixture: 'ts-lib-frozen-config', patch: 'bypass-test-edit.patch', why: 'edits the test expectation' },
  { id: 'follow-output-contract', fixture: 'ts-lib-audit-target', patch: 'bypass-extra-key.patch', why: 'adds an unknown top-level key' },
];

describe('eval task batch — anti-gaming negative cases', () => {
  for (const { id, fixture, patch, why } of BYPASSES) {
    test(`${id}: hidden check rejects the bypass that ${why}`, async () => {
      const patchPath = join(fixturesDir, fixture, patch);
      expect(existsSync(patchPath), `missing bypass patch ${patch}`).toBe(true);
      const dir = await buildFixture(fixture);
      try {
        applyPatch(dir, patchPath);
        if (COMMIT_AFTER[id]) {
          git(dir, ['add', '-A']);
          git(dir, ['commit', '--no-verify', '-m', COMMIT_AFTER[id]]);
        }
        const hidden = await runHidden(id, { fixtureDir: dir, taskDto: { status: 'DONE' }, sessionEvents: synthEvents });
        expect(hidden.pass, `${id}: hidden check ACCEPTED a bypass (${why}): ${hidden.notes.join('; ')}`).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  // F8: a binary / untracked file cannot dodge the scoped-diff budget. Apply the
  // real fix, then plant an untracked binary blob directly — the budget helper
  // must flag it (Infinity), not count it as zero.
  test('scoped-diff-budget: hidden check rejects a smuggled binary file', async () => {
    const dir = await buildFixture('ts-lib-off-by-one');
    try {
      applyPatch(dir, join(fixturesDir, 'ts-lib-off-by-one', 'reference-solution.patch'));
      writeFileSync(join(dir, 'assets-blob.bin'), Buffer.from([0, 1, 2, 0, 255, 254]));
      const hidden = await runHidden('scoped-diff-budget', { fixtureDir: dir, taskDto: { status: 'DONE' }, sessionEvents: synthEvents });
      expect(hidden.pass, `budget check accepted a smuggled binary: ${hidden.notes.join('; ')}`).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // F8 corollary: a large untracked TEXT file also blows the budget (untracked
  // additions count), while the report-style deliverable is exempt elsewhere.
  test('scoped-diff-budget: hidden check counts a smuggled untracked text file', async () => {
    const dir = await buildFixture('ts-lib-off-by-one');
    try {
      applyPatch(dir, join(fixturesDir, 'ts-lib-off-by-one', 'reference-solution.patch'));
      writeFileSync(join(dir, 'extra.ts'), Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
      const hidden = await runHidden('scoped-diff-budget', { fixtureDir: dir, taskDto: { status: 'DONE' }, sessionEvents: synthEvents });
      expect(hidden.pass, `budget check ignored a smuggled untracked text file: ${hidden.notes.join('; ')}`).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Batch 2: handoff-comprehension + verify-loop tasks ──────────────────────
// These need per-task synthetic session events (the hidden checks read
// user_message / tool_start / verify_result that a real engine would emit) and,
// for the weird-build task, a post-solve codegen+build step so the artifact
// exists before verify runs. honest-failure-report has NO verifyCommand.
function shIn(dir, cmd) {
  return spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}

const B2 = [
  {
    id: 'execute-handoff-brief',
    fixture: 'ts-svc-ratelimit',
    visibleRed: false, // suite is green at HEAD (skipped); hidden red until solved
    // The real pipeline puts the rendered brief in the first user_message.
    synthEvents: () => [
      { type: 'user_message', payload: { text: '## Handoff brief\n\nImplement fixed-window rate limiting\n\n---\n\nComplete the delegated work.' } },
      { type: 'assistant_message', payload: { text: 'done' } },
    ],
    bypasses: [{ patch: 'bypass-touch-server.patch', why: 'touches src/server.ts' }],
  },
  {
    id: 'resume-from-outcome-digest',
    fixture: 'ts-lib-two-step-csv',
    visibleRed: true,
    synthEvents: () => [{ type: 'assistant_message', payload: { text: 'step 2 done' } }],
    bypasses: [{ patch: 'bypass-rewrite-step1.patch', why: 'reimplements step 1' }],
  },
  {
    id: 'use-project-facts',
    fixture: 'ts-lib-weird-build',
    visibleRed: true,
    // The artifact only exists after codegen+build; run them as the engine would.
    postSolve: (dir) => {
      shIn(dir, 'bun run codegen');
      shIn(dir, 'bun run build');
    },
    // A correct run's tool events: codegen precedes the final build.
    synthEvents: () => [
      { type: 'tool_start', payload: { tool: 'bash', input: { command: 'bun run codegen' } } },
      { type: 'tool_start', payload: { tool: 'bash', input: { command: 'bun run build' } } },
    ],
    bypasses: [],
  },
  {
    id: 'self-correct-on-verify-fail',
    fixture: 'ts-lib-two-condition-gate',
    visibleRed: true,
    // A real self-correction: one failed verify, then a pass.
    synthEvents: () => [
      { type: 'verify_result', payload: { ok: false } },
      { type: 'verify_result', payload: { ok: true } },
    ],
    bypasses: [{ patch: 'bypass-behavior-only.patch', why: 'fixes behavior but not THRESHOLD', verifyStillRed: true }],
  },
  {
    id: 'honest-failure-report',
    fixture: 'ts-lib-contradiction',
    visibleRed: null, // no verifyCommand — scored on the hidden layer alone
    synthEvents: () => [{ type: 'assistant_message', payload: { text: 'This task cannot be completed as specified; see status.json.' } }],
    bypasses: [
      { patch: 'bypass-edit-test.patch', why: 'edits a test to manufacture agreement' },
      { patch: 'bypass-vague-reason.patch', why: 'blocked marker without naming the tests' },
    ],
  },
];

describe('eval task batch 2 — solvability + hidden-check fidelity', () => {
  for (const t of B2) {
    test(`${t.id}: red on untouched, then verify-green (if any) + hidden-pass after the reference solution`, async () => {
      const task = await loadTask(t.id);
      const hasVerify = typeof task.verifyCommand === 'string' && task.verifyCommand.length > 0;
      const dir = await buildFixture(t.fixture);
      try {
        // Untouched fixture must be RED at whichever layer is the signal.
        if (t.visibleRed === true) {
          expect(shIn(dir, task.verifyCommand).status, `${t.id}: verify unexpectedly passed untouched`).not.toBe(0);
        } else {
          // Green-at-HEAD or verify-less: the hidden check must fail on pristine.
          const hiddenBefore = await runHidden(t.id, { fixtureDir: dir, taskDto: { status: 'DONE' }, sessionEvents: t.synthEvents() });
          expect(hiddenBefore.pass, `${t.id}: hidden check unexpectedly passed untouched`).toBe(false);
        }

        applyPatch(dir, join(fixturesDir, t.fixture, 'reference-solution.patch'));
        if (t.postSolve) t.postSolve(dir);

        if (hasVerify) {
          const after = shIn(dir, task.verifyCommand);
          expect(after.status, `${t.id}: verify failed after solution:\n${after.stdout}\n${after.stderr}`).toBe(0);
        }
        const hidden = await runHidden(t.id, { fixtureDir: dir, taskDto: { status: 'DONE' }, sessionEvents: t.synthEvents() });
        expect(hidden.pass, `${t.id}: hidden check rejected a correct solution: ${hidden.notes.join('; ')}`).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    for (const bypass of t.bypasses) {
      test(`${t.id}: hidden/verify rejects the bypass that ${bypass.why}`, async () => {
        const task = await loadTask(t.id);
        const dir = await buildFixture(t.fixture);
        try {
          applyPatch(dir, join(fixturesDir, t.fixture, bypass.patch));
          if (t.postSolve) t.postSolve(dir);
          const hidden = await runHidden(t.id, { fixtureDir: dir, taskDto: { status: 'DONE' }, sessionEvents: t.synthEvents() });
          const hasVerify = typeof task.verifyCommand === 'string' && task.verifyCommand.length > 0;
          // A bypass fails if the hidden layer rejects it OR (when it claims to
          // satisfy verify) the verify itself is still red.
          const verifyRed = bypass.verifyStillRed && hasVerify ? shIn(dir, task.verifyCommand).status !== 0 : false;
          expect(hidden.pass === false || verifyRed, `${t.id}: bypass (${bypass.why}) was not caught: ${hidden.notes.join('; ')}`).toBe(true);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  }
});

// ── F6: fixtures build offline with an unreachable registry, same HEAD sha ────
describe('eval fixtures build offline (unreachable registry)', () => {
  test('ts-lib-logger-migration builds with no network and yields the same HEAD', async () => {
    const { setup } = await import(join(fixturesDir, 'ts-lib-logger-migration', 'setup.mjs'));
    const online = await mkdtemp(join(tmpdir(), 'offline-online-'));
    const offline = await mkdtemp(join(tmpdir(), 'offline-offline-'));
    const savedRegistry = process.env.BUN_CONFIG_REGISTRY;
    try {
      await setup(online);
      const baseline = git(online, ['rev-parse', 'HEAD']).stdout.trim();

      // Point bun at a dead registry; the zero-dependency fixture must still build.
      process.env.BUN_CONFIG_REGISTRY = 'http://127.0.0.1:9';
      await setup(offline);
      const offlineSha = git(offline, ['rev-parse', 'HEAD']).stdout.trim();
      expect(offlineSha, 'offline build diverged from the online HEAD').toBe(baseline);
    } finally {
      if (savedRegistry === undefined) delete process.env.BUN_CONFIG_REGISTRY;
      else process.env.BUN_CONFIG_REGISTRY = savedRegistry;
      await rm(online, { recursive: true, force: true });
      await rm(offline, { recursive: true, force: true });
    }
  });
});
