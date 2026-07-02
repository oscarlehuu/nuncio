---
"nuncio": minor
---

Added the hub client: when served through a hub at `/m/<machine>/`, the web app routes every API, SSE, and terminal-WebSocket call to that machine (single fetch chokepoint + react-router basename), and a Machines switcher in the sidebar lists every tailnet machine the hub can reach. Cmd/ctrl-click a machine to open it in a new tab and work on several machines in parallel. Served directly (not via a hub), nothing changes.
