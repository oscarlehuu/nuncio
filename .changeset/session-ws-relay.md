---
"nuncio": minor
---

Session WebSocket relay: live transcripts and steering now ride one duplex `ws(s)://…/api/sessions/ws` channel with the event-log `seq` cursor on top — subscriptions replay from the client's cursor and reconnects are gap-free, bounded outbound buffers drop slow consumers to cursor recovery instead of buffering unboundedly, and upgrades are gated by the same loopback/token/tailnet rule as the REST API. The hub now relays the session WS path (`/m/<machine>/api/sessions/ws`) and — security fix — authorizes every proxied request and WS upgrade at the hub edge instead of forwarding unauthenticated traffic to whois-trusting targets. The web transcript stream migrated from EventSource/SSE to the shared `@nuncio/core` relay client with identical behavior; the SSE endpoint remains for API consumers. Contract frozen in docs/ws-relay-contract.md.
