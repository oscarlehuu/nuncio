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

// Import the loader under test.
const { loadHiddenCheck } = await import('./lib/eval-suite.mjs');

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
