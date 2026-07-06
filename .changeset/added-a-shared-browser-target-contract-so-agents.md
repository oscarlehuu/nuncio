---
"nuncio": patch
---

Added a shared browser target contract and wired it into Pi, Cursor, and Codex agents so browser requests can prefer the in-app browser and fall back to the Nuncio-owned external browser. The default browser target is now configurable from Settings -> MCP & Tools, and Codex app-server sessions now opt in to the experimental API capability required for dynamic tools.
