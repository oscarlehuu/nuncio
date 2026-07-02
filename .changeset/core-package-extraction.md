---
"nuncio": patch
---

Extract `packages/core` — the portable client layer (session/model/handoff API modules, transcript block builder, tool summaries, design tokens) now lives in `@nuncio/core` with an injectable base URL + auth-header seam, shared by the web app today and the upcoming Expo mobile client. Web behavior is unchanged.
