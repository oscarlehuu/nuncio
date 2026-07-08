// Fixture: a small package with EXACTLY three `TODO:` comments and two
// `@ts-ignore` directives planted at known locations in src/. The task writes a
// report to reports/audit.json listing them; the hidden check compares against
// the planted ground truth. Ships verify.sh (existence + jq shape) as the
// visible layer. Zero deps (jq is a system tool; the hidden check parses JSON
// itself so jq's absence never fails scoring).
import { buildFixture } from '../lib/deterministic-git.mjs';

// Ground-truth planted locations (1-based lines), kept in the fixture source so
// the hidden check imports them rather than re-deriving. Exported for the check.
export const PLANTED = {
  todos: [
    { file: 'src/parser.ts', line: 3 },
    { file: 'src/parser.ts', line: 9 },
    { file: 'src/render.ts', line: 4 },
  ],
  tsIgnores: [
    { file: 'src/parser.ts', line: 6 },
    { file: 'src/render.ts', line: 8 },
  ],
};

const FILES = {
  'package.json': `${JSON.stringify(
    { name: 'ts-lib-audit-target', version: '0.0.0', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  )}\n`,
  // parser.ts: TODO at line 3, @ts-ignore at line 6, TODO at line 9.
  'src/parser.ts': `export function parse(input: string): string[] {
  const parts = input.split(',');
  // TODO: trim whitespace around each part
  return parts.map((p) => {
    const n = p as unknown;
    // @ts-ignore intentional narrowing gap
    return String(n).toUpperCase();
  });
  // TODO: reject empty segments
}
`,
  // render.ts: TODO at line 4, @ts-ignore at line 8.
  'src/render.ts': `import { parse } from './parser';

export function render(input: string): string {
  // TODO: escape HTML entities
  const items = parse(input);
  return items
    .map((item) => {
      // @ts-ignore item is always a string here
      return item.length > 0 ? item : '-';
    })
    .join('\\n');
}
`,
  'src/index.ts': `export { parse } from './parser';
export { render } from './render';
`,
  'test/render.spec.ts': `import { expect, test } from 'bun:test';
import { render } from '../src/render';

test('render upper-cases and joins', () => {
  expect(render('a,b')).toBe('A\\nB');
});
`,
  // Visible verify: existence + jq shape check. Exits non-zero when the report
  // is missing (the untouched state) or malformed.
  'verify.sh': `#!/bin/sh
set -e
test -f reports/audit.json
if command -v jq >/dev/null 2>&1; then
  jq -e 'has("todos") and has("tsIgnores")' reports/audit.json >/dev/null
fi
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES);
  return dir;
}
