// Fixture: a tiny TS+bun lib whose slugify has a real bug — the space-collapsing
// regex is missing the global flag, so only the FIRST space becomes a dash and
// the multi-word test fails. truncate.ts and its test are correct. Reused by
// both the fix-failing-unit-test and conventional-commit tasks (one fixture,
// several task jsons). Zero dependencies — `bun test` needs no install.
import { buildFixture } from '../lib/deterministic-git.mjs';

const FILES = {
  'package.json': `${JSON.stringify(
    { name: 'ts-lib-broken-slugify', version: '0.0.0', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  )}\n`,
  'src/slugify.ts': `export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\\s/, '-')
    .replace(/[^a-z0-9-]/g, '');
}
`,
  'src/truncate.ts': `export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return \`\${input.slice(0, Math.max(0, max - 1))}…\`;
}
`,
  'test/slugify.spec.ts': `import { expect, test } from 'bun:test';
import { slugify } from '../src/slugify';

test('lowercases a single word', () => {
  expect(slugify('Hello')).toBe('hello');
});

test('replaces every space with a dash', () => {
  expect(slugify('Hello World Again')).toBe('hello-world-again');
});

test('strips punctuation', () => {
  expect(slugify('a!b?c')).toBe('abc');
});
`,
  'test/truncate.spec.ts': `import { expect, test } from 'bun:test';
import { truncate } from '../src/truncate';

test('leaves short strings alone', () => {
  expect(truncate('hi', 10)).toBe('hi');
});

test('truncates with an ellipsis', () => {
  expect(truncate('abcdef', 4)).toBe('abc…');
});
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES);
  return dir;
}
