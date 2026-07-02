---
"nuncio": minor
---

Added loopback-exempt token auth so the server can be reached safely from other machines: local (loopback) clients need no setup, while remote clients present an auto-generated access token once and get an HttpOnly cookie that also authenticates the SSE stream and the in-browser terminal. Forge webhooks keep their own HMAC verification and stay exempt.
