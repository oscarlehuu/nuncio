import path from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Exposes the repo-root `CHANGELOG.md` (produced by Changesets) to the landing
 * bundle as `virtual:changelog`. Reading it at build time means the landing
 * page's Changelog section always reflects the committed changelog without a
 * runtime fetch — every rebuild on `main` picks up the latest releases.
 *
 * Mirrors the same plugin in apps/web/vite.config.ts so the two stay in sync.
 */
function changelogPlugin() {
  const virtualModuleId = 'virtual:changelog';
  const resolvedVirtualModuleId = `\0${virtualModuleId}`;
  const changelogPath = path.resolve(__dirname, '../../CHANGELOG.md');
  return {
    name: 'nuncio-landing-changelog-loader',
    resolveId(id: string) {
      if (id === virtualModuleId) return resolvedVirtualModuleId;
      return null;
    },
    load(id: string) {
      if (id !== resolvedVirtualModuleId) return null;
      const raw = readFileSync(changelogPath, 'utf8');
      return `export default ${JSON.stringify(raw)};`;
    },
  };
}

export default defineConfig({
  // GitHub Pages for oscarlehuu/nuncio serves at /nuncio/ — set base so all
  // assets resolve correctly. Dev server uses '/' which is fine for preview.
  base: '/nuncio/',
  plugins: [react(), changelogPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost' },
    },
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
  server: {
    port: 5174,
  },
});
