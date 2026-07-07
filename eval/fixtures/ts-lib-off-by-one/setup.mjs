// Fixture: a pagination module with a single off-by-one bug (fix is <=3 changed
// lines) surrounded by ugly-but-working code that invites cleanup — inconsistent
// naming, a redundant loop. The budget task rewards touching ONLY the bug line.
// Zero dependencies.
import { buildFixture } from '../lib/deterministic-git.mjs';

const FILES = {
  'package.json': `${JSON.stringify(
    { name: 'ts-lib-off-by-one', version: '0.0.0', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  )}\n`,
  // The off-by-one is in totalPages: it uses Math.floor where it must use
  // Math.ceil, so a partial final page is dropped. The surrounding code is
  // deliberately ugly (redundant loop, inconsistent naming) to bait a refactor.
  'src/paginate.ts': `export interface Page<T> {
  items: T[];
  pageCount: number;
}

export function paginate<T>(all_Items: T[], perPage: number): Page<T> {
  // deliberately redundant: copy the slice element by element
  var firstPage: T[] = [];
  for (let I = 0; I < all_Items.length && I < perPage; I = I + 1) {
    firstPage.push(all_Items[I]);
  }
  const totalPages = Math.floor(all_Items.length / perPage);
  return { items: firstPage, pageCount: totalPages };
}
`,
  'test/paginate.spec.ts': `import { expect, test } from 'bun:test';
import { paginate } from '../src/paginate';

test('a partial final page still counts as a page', () => {
  // 7 items, 3 per page → 3 pages (3 + 3 + 1).
  expect(paginate([1, 2, 3, 4, 5, 6, 7], 3).pageCount).toBe(3);
});

test('exact multiples count correctly', () => {
  expect(paginate([1, 2, 3, 4], 2).pageCount).toBe(2);
});

test('returns the first page of items', () => {
  expect(paginate([1, 2, 3, 4, 5], 2).items).toEqual([1, 2]);
});
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES);
  return dir;
}
