/*
 * The web app used to ship as a PWA with a workbox service worker that
 * precached the app shell. Clients that installed that SW would otherwise be
 * pinned to a stale cached build forever, even after we stop shipping sw.js —
 * the old SW keeps serving its precache and never sees new deploys.
 *
 * On startup, tear down any leftover service worker and purge its caches so
 * those clients recover on the next navigation. Fire-and-forget, no UI: a
 * failure here just means the (rare) legacy client retries next load.
 */
export function unregisterLegacyServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  void (async () => {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));

      if (typeof window !== 'undefined' && 'caches' in window) {
        const cacheKeys = await caches.keys();
        await Promise.all(
          cacheKeys
            .filter((key) => key.includes('workbox') || key.includes('nuncio'))
            .map((key) => caches.delete(key)),
        );
      }
    } catch {
      // Best-effort cleanup; ignore (SecurityError on insecure origins, etc.).
    }
  })();
}
