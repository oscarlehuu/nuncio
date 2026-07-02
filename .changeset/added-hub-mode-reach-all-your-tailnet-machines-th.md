---
"nuncio": minor
---

Added hub mode (server side): a nuncio server can reach your other tailnet machines running nuncio through one URL at `/m/<machine>/`. The hub auto-discovers same-account machines (health-probed), proxies their HTTP, SSE, and terminal WebSocket traffic, and authorizes hub→machine calls by tailnet identity. The `<machine>` segment resolves only against the discovered registry — never an arbitrary target (SSRF-guarded). Off by default; toggle via the Hub mode setting.
