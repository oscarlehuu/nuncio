import path from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Exposes the repo-root `CHANGELOG.md` (produced by Changesets) to the web bundle
 * as `virtual:changelog`. Reading it at build/dev start time means the in-app
 * "What's new" page always reflects the committed changelog without a runtime
 * fetch. The file only changes on release, so a dev-server restart to pick up
 * a new version is acceptable.
 */
function changelogPlugin() {
  const virtualModuleId = 'virtual:changelog';
  const resolvedVirtualModuleId = `\0${virtualModuleId}`;
  const changelogPath = path.resolve(__dirname, '../../CHANGELOG.md');
  return {
    name: 'nuncio-changelog-loader',
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

function readPort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

const webPort = readPort(process.env.NUNCIO_WEB_PORT, 5173);
const apiTarget = process.env.NUNCIO_API_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  appType: 'spa',
  plugins: [
    react(),
    tailwindcss(),
    changelogPlugin(),
  ],
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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.spec.{ts,tsx}',
        'src/test/**',
        'src/components/ui/**',
        'src/vite-env.d.ts',
        'src/qrcode-react.d.ts',
      ],
    },
  },
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        // Forward /api/terminal PTY WebSocket upgrades to the API server in dev.
        ws: true,
      },
    },
  },
  preview: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
