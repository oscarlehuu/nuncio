// Scoring-integrity unit tests for the hidden-check loader. The load path must
// distinguish "no check file" (legal → pass-through) from "check file present
// but broken" (a typo'd import, syntax error, missing export → a real defect
// that must surface, NEVER a silent pass). Runs under `bun run test:scripts`.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const checksDir = join(scriptDir, '..', 'eval', 'checks');

// Import the units under test.
const { loadHiddenCheck, validateTask, renderMarkdownTable, buildReport } = await import('./lib/eval-suite.mjs');

// Unique per-run task ids so we can drop real files into eval/checks and clean
// them up, without colliding with the committed smoke-mock-echo check.
const madeFiles = [];
function writeCheck(taskId, contents) {
  const path = join(checksDir, `${taskId}.mjs`);
  writeFileSync(path, contents, 'utf8');
  madeFiles.push(path);
  return path;
}

afterAll(() => {
  for (const f of madeFiles) rmSync(f, { force: true });
});

describe('loadHiddenCheck scoring integrity', () => {
  test('a genuinely absent check file resolves to a pass-through', async () => {
    const fn = await loadHiddenCheck(`__nonexistent-${Date.now()}`);
    const result = await fn({ fixtureDir: '/tmp', taskDto: {}, sessionEvents: [] });
    expect(result.pass).toBe(true);
  });

  test('a present check with a broken import throws (never a silent pass)', async () => {
    const taskId = `__broken-import-${Date.now()}`;
    writeCheck(taskId, "import x from './definitely-missing-helper.mjs';\nexport default () => ({ pass: true, notes: [] });\n");
    // The file exists, so the loader must surface the import failure rather than
    // treating it as "no check" and passing the task.
    await expect(loadHiddenCheck(taskId)).rejects.toThrow(/missing-helper/);
  });

  test('a present check missing its export throws', async () => {
    const taskId = `__no-export-${Date.now()}`;
    writeCheck(taskId, 'export const notTheDefault = 1;\n');
    await expect(loadHiddenCheck(taskId)).rejects.toThrow(/default-export a check function/);
  });

  test('a valid present check is returned and callable', async () => {
    const taskId = `__valid-${Date.now()}`;
    writeCheck(taskId, "export default ({ sessionEvents }) => ({ pass: sessionEvents.length > 0, notes: [] });\n");
    const fn = await loadHiddenCheck(taskId);
    expect((await fn({ sessionEvents: [{}] })).pass).toBe(true);
    expect((await fn({ sessionEvents: [] })).pass).toBe(false);
  });
});

describe('validateTask (verify-less + informational guardrails)', () => {
  const base = { id: 't', title: 'T', fixture: 'f', prompt: 'p', timeoutMs: 1000, verifyCommand: 'bun test' };

  test('a normal task with a verifyCommand validates; informational defaults false', () => {
    const task = { ...base };
    expect(() => validateTask(task, 't.json')).not.toThrow();
    expect(task.informational).toBe(false);
  });

  test('a missing verifyCommand is REJECTED unless scoring: hidden-only', () => {
    const bad = { ...base };
    delete bad.verifyCommand;
    expect(() => validateTask(bad, 't.json')).toThrow(/no verifyCommand/);
    const ok = { ...bad, scoring: 'hidden-only' };
    expect(() => validateTask(ok, 't.json')).not.toThrow();
  });

  test('an invalid scoring value is rejected', () => {
    expect(() => validateTask({ ...base, scoring: 'whatever' }, 't.json')).toThrow(/scoring must be "hidden-only"/);
  });

  test('informational: true REQUIRES the control tag', () => {
    expect(() => validateTask({ ...base, informational: true, tags: ['x'] }, 't.json')).toThrow(/tags do not include 'control'/);
    const ok = { ...base, informational: true, tags: ['x', 'control'] };
    expect(() => validateTask(ok, 't.json')).not.toThrow();
    expect(ok.informational).toBe(true);
  });

  test('rejects a non-string verifyCommand', () => {
    expect(() => validateTask({ ...base, verifyCommand: 42 }, 't.json')).toThrow(/verifyCommand must be a string/);
  });

  test('still requires the core fields', () => {
    expect(() => validateTask({ title: 'x', fixture: 'f', prompt: 'p', timeoutMs: 1, verifyCommand: 'x' }, 't.json')).toThrow(/missing required field/);
  });
});

describe('renderMarkdownTable (info rows + null verify)', () => {
  test("a verify-less row renders verify as '—'", () => {
    const table = renderMarkdownTable([
      { taskId: 'verifyless', pass: true, verifyPassed: null, hiddenPassed: true, durationMs: 1, rounds: 0, notes: [] },
    ]);
    // pass PASS, verify '—', hidden PASS
    expect(table).toContain('| verifyless | PASS | — | PASS |');
  });

  test("an informational row is tagged and its pass shown as '—'", () => {
    const table = renderMarkdownTable([
      { taskId: 'ctrl', informational: true, pass: false, verifyPassed: false, hiddenPassed: false, durationMs: 1, rounds: 0, notes: [] },
    ]);
    expect(table).toContain('| ctrl (info) | — |');
  });
});

describe('buildReport passRate excludes informational rows', () => {
  test('a failing control row does not drag down the pass rate', () => {
    const report = buildReport({
      engine: 'mock',
      model: 'm',
      results: [
        { taskId: 'a', pass: true },
        { taskId: 'ctrl', informational: true, pass: false },
      ],
    });
    // 1 graded task, 1 pass → 100%, the control excluded.
    expect(report.passRate).toBe(1);
    expect(report.results).toHaveLength(2); // still reported
  });

  test('a run of only informational rows yields passRate 0 (no graded denominator)', () => {
    const report = buildReport({
      engine: 'mock',
      model: 'm',
      results: [{ taskId: 'ctrl', informational: true, pass: false }],
    });
    expect(report.passRate).toBe(0);
  });
});
