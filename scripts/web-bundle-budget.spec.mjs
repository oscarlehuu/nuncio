import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Guards the web entry chunk against silent bloat: heavy libraries (mermaid,
 * xterm) are code-split behind dynamic imports, and a static import creeping
 * back in would land them in the entry chunk and blow this budget. Skips when
 * `apps/web/dist` is absent (unit-test-only runs); `bun run gate` builds first.
 */
const assetsDir = join(import.meta.dir, '..', 'apps', 'web', 'dist', 'assets');
const built = existsSync(assetsDir);

/** Entry gzip size was ~241 kB when the budget was set; headroom ~16%. */
const ENTRY_GZIP_BUDGET_BYTES = 280_000;

describe('web bundle budget', () => {
  it.skipIf(!built)('keeps the entry chunk gzip size under budget', () => {
    const entryChunks = readdirSync(assetsDir).filter((name) =>
      /^index-.*\.js$/.test(name),
    );
    expect(entryChunks.length).toBe(1);
    const gzipBytes = gzipSync(readFileSync(join(assetsDir, entryChunks[0]))).length;
    expect(gzipBytes).toBeLessThan(ENTRY_GZIP_BUDGET_BYTES);
  });

  it.skipIf(!built)('keeps mermaid and xterm out of the entry chunk', () => {
    const jsChunks = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
    const isEntry = (name) => /^index-.*\.js$/.test(name);
    const entryChunks = jsChunks.filter(isEntry);
    expect(entryChunks.length).toBe(1);

    const entrySource = readFileSync(join(assetsDir, entryChunks[0]), 'utf8');
    // Markers verified present in the lazy chunks (mermaid's `startOnLoad`
    // config key, xterm's `xterm-viewport` class) and absent from the entry.
    const markers = ['startOnLoad', 'xterm-viewport'];
    for (const marker of markers) {
      expect(entrySource.includes(marker)).toBe(false);
    }

    // Positive control: the markers must still exist in some lazy chunk. If a
    // mermaid/xterm upgrade renames these internals, the negative assertions
    // above would silently pass on a marker that no longer exists anywhere —
    // catch that here so a rename fails loudly instead of going vacuous.
    const lazySources = jsChunks
      .filter((name) => !isEntry(name))
      .map((name) => readFileSync(join(assetsDir, name), 'utf8'));
    for (const marker of markers) {
      expect(lazySources.some((src) => src.includes(marker))).toBe(true);
    }
  });
});
