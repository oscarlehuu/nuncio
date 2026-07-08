// Fixture: a feature that naturally splits into a self-contained pure module
// (src/tokenize.ts — fully specified, no shared state) and an integration part
// (src/highlight.ts consuming it). The delegator should hand the tokenizer off
// as a subtask and build the highlighter on top. Both halves are unimplemented
// stubs at HEAD; bun test fails until both are done. Zero dependencies.
import { buildFixture } from '../lib/deterministic-git.mjs';

const FILES = {
  'package.json': `${JSON.stringify(
    { name: 'ts-lib-two-module-feature', version: '0.0.0', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  )}\n`,
  'SPEC.md': `# Highlight feature

Two independent halves:

## Tokenizer — src/tokenize.ts (self-contained, no shared state)

\`tokenize(input: string): Token[]\` splits an input string into tokens of three
types:
- \`word\`  — a maximal run of [A-Za-z0-9]
- \`space\` — a maximal run of whitespace
- \`punct\` — any single other character

\`Token\` is \`{ type: 'word' | 'space' | 'punct'; value: string }\`. Tokens
concatenated in order reproduce the input exactly.

## Highlighter — src/highlight.ts (integration, consumes the tokenizer)

\`highlight(input: string): string\` wraps every \`word\` token in \`[\` and \`]\`
and leaves \`space\`/\`punct\` tokens untouched.
`,
  'src/tokenize.ts': `export interface Token {
  type: 'word' | 'space' | 'punct';
  value: string;
}

/** Split input into word / space / punct tokens (see SPEC.md). NOT IMPLEMENTED. */
export function tokenize(_input: string): Token[] {
  throw new Error('not implemented');
}
`,
  'src/highlight.ts': `import { tokenize } from './tokenize';

/** Wrap every word token in brackets (see SPEC.md). NOT IMPLEMENTED. */
export function highlight(_input: string): string {
  void tokenize;
  throw new Error('not implemented');
}
`,
  'test/tokenize.spec.ts': `import { expect, test } from 'bun:test';
import { tokenize } from '../src/tokenize';

test('splits words, spaces, and punctuation', () => {
  expect(tokenize('ab, c')).toEqual([
    { type: 'word', value: 'ab' },
    { type: 'punct', value: ',' },
    { type: 'space', value: ' ' },
    { type: 'word', value: 'c' },
  ]);
});

test('round-trips to the original input', () => {
  const input = 'Hi  there!';
  expect(tokenize(input).map((t) => t.value).join('')).toBe(input);
});
`,
  'test/highlight.spec.ts': `import { expect, test } from 'bun:test';
import { highlight } from '../src/highlight';

test('brackets words only', () => {
  expect(highlight('ab, c')).toBe('[ab], [c]');
});
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES);
  return dir;
}
