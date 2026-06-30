import path from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

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
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'favicon-48.png', 'favicon-32.png', 'favicon-16.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Nuncio',
        short_name: 'Nuncio',
        description: 'Self-hosted AI agent delegation',
        theme_color: '#0d0f12',
        background_color: '#0d0f12',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'nuncio-api-cache',
              networkTimeoutSeconds: 10,
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24,
              },
            },
          },
        ],
      },
    }),
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
  },
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
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
      },
    },
  },
});
