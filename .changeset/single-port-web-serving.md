---
"@nuncio/server": patch
---

Serve the built web app from the Nest/Bun daemon when `apps/web/dist` is present, with SPA fallback for non-API routes while keeping `/api/*` JSON routes authoritative.
