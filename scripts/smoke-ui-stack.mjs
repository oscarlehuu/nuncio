// Level-5 UI smoke stack shim. The daemon-boot recipe now lives in the shared
// scripts/lib/hermetic-stack.mjs (consumed by the eval runner too); this file
// keeps the smoke's original surface and, crucially, serves the web dist
// same-origin so the real browser has a UI to drive. See hermetic-stack.mjs for
// the isolation guarantees (ephemeral port, fresh temp NUNCIO_DATA_DIR).
import {
  ensureWebBuild,
  findFreePort,
  repoRoot,
  startServer as startHermeticServer,
  webDist,
} from './lib/hermetic-stack.mjs';

export { ensureWebBuild, findFreePort, repoRoot, webDist };

/**
 * Boot the isolated stack WITH the web bundle served same-origin — the smoke
 * drives real Chrome against it. Delegates lifecycle to the shared lib.
 * `dataDir` lets a caller reboot on the SAME durable DB (WS-reconnect journey).
 */
export function startServer({ port, healthTimeoutMs = 45000, dataDir } = {}) {
  return startHermeticServer({ port, healthTimeoutMs, serveWebDist: webDist, dataDir });
}
