// Fixture: a two-step CSV chain where STEP 1 is already done. src/csv-parse.ts
// (parseCsv, RFC 4180) is complete with passing tests; src/csv-stringify.ts is an
// unimplemented stub with failing round-trip tests. The engine, given step 1's
// outcome digest in the brief, must implement step 2 WITHOUT reimplementing or
// touching step 1. Zero dependencies. Seed commit message names step 1 of 2.
import { buildFixture } from '../lib/deterministic-git.mjs';

const FILES = {
  'package.json': `${JSON.stringify(
    { name: 'ts-lib-two-step-csv', version: '0.0.0', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  )}\n`,
  // STEP 1 — complete. Do not modify.
  'src/csv-parse.ts': `/**
 * Parse RFC 4180 CSV into rows of fields. A field may be quoted with double
 * quotes; inside a quoted field, "" is a literal quote and commas/newlines are
 * data. Unquoted fields end at the next comma or newline.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      pushField();
      i += 1;
    } else if (ch === '\\n') {
      pushRow();
      i += 1;
    } else if (ch === '\\r') {
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}
`,
  // STEP 2 — the engine's job. Failing stub.
  'src/csv-stringify.ts': `/**
 * Serialize rows of fields back to RFC 4180 CSV. Round-trip with parseCsv: a
 * field is quoted when it contains a comma, a double quote, or a newline;
 * embedded double quotes are escaped by doubling. Rows are joined with '\\n'.
 * NOT YET IMPLEMENTED.
 */
export function stringifyCsv(_rows: string[][]): string {
  throw new Error('not implemented');
}
`,
  // Step 1's own tests — passing, must stay byte-identical.
  'test/csv-parse.spec.ts': `import { expect, test } from 'bun:test';
import { parseCsv } from '../src/csv-parse';

test('parses simple rows', () => {
  expect(parseCsv('a,b\\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
});

test('parses a quoted field with a comma', () => {
  expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']]);
});

test('parses doubled quotes as a literal quote', () => {
  expect(parseCsv('"he said ""hi"""')).toEqual([['he said "hi"']]);
});
`,
  // Step 2's tests — failing until the stringifier is implemented. Includes the
  // round-trip property.
  'test/csv-stringify.spec.ts': `import { expect, test } from 'bun:test';
import { parseCsv } from '../src/csv-parse';
import { stringifyCsv } from '../src/csv-stringify';

test('quotes a field containing a comma', () => {
  expect(stringifyCsv([['a,b', 'c']])).toBe('"a,b",c');
});

test('round-trips parse → stringify → parse', () => {
  const rows = [['plain', 'with,comma'], ['line1\\nline2', 'quote"inside']];
  expect(parseCsv(stringifyCsv(rows))).toEqual(rows);
});
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES, 'feat: csv parser (step 1 of 2)');
  return dir;
}
