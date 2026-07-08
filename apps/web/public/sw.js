/*
 * Self-destroying service worker — a tombstone, NOT a caching worker.
 *
 * The web app used to ship as a PWA with a workbox service worker that
 * precached the app shell. Those legacy clients keep their old SW installed and
 * keep serving the STALE precached build forever — they never see new deploys,
 * and their periodic `/sw.js` update check would normally fetch this path. But
 * the server SPA-fallbacks every unmatched GET to index.html, so a missing
 * `/sw.js` would return HTML with the wrong MIME type: the update fails, the old
 * SW survives, and the stale shell is pinned. The in-app cleanup in
 * `src/lib/unregister-service-worker.ts` can't help those clients because the
 * fresh bundle it lives in never loads.
 *
 * So we ship a real, valid `/sw.js` whose only job is to remove itself: skip
 * waiting → purge the old caches → unregister → reload open tabs into the fresh,
 * un-cached app. Once served, the browser's update check gets valid JS, installs
 * this worker, and it tears everything down on activate.
 *
 * SAFE TO DELETE after a few releases, once legacy workbox clients have all had
 * a chance to fetch this and self-destruct. Deleting it re-exposes the HTML-for-
 * /sw.js failure, so only remove it when confident no pinned client remains.
 */

self.addEventListener('install', () => {
  // Activate immediately even while the old workbox SW is still controlling.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Purge the legacy precache/runtime caches. Scope the match so we never
      // nuke unrelated same-origin caches. Best-effort: a failed delete must not
      // abort the unregister + reload below.
      try {
        if ('caches' in self) {
          const keys = await caches.keys();
          await Promise.all(
            keys
              .filter((key) => key.includes('workbox') || key.includes('nuncio'))
              .map((key) => caches.delete(key).catch(() => undefined)),
          );
        }
      } catch {
        // CacheStorage unavailable or rejected — carry on with teardown.
      }

      // Remove this worker so future loads hit the network directly.
      try {
        await self.registration.unregister();
      } catch {
        // Already gone / unsupported — nothing to do.
      }

      // Reload every open tab so it drops the SW-controlled stale shell and
      // navigates into the current build. client.url is same-origin, so
      // navigate() is permitted; guard per-client so one failure doesn't stop
      // the rest.
      try {
        const clients = await self.clients.matchAll({ type: 'window' });
        await Promise.all(
          clients.map((client) => {
            if (typeof client.navigate !== 'function') return undefined;
            return Promise.resolve(client.navigate(client.url)).catch(() => undefined);
          }),
        );
      } catch {
        // clients API unavailable — the next manual reload still recovers.
      }
    })(),
  );
});
