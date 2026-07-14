---
"nuncio": patch
---

Smoothed live token streaming: assistant and thinking text now flushes to the transcript every 25ms instead of 100ms, so streaming reads close to per-token instead of arriving in chunky bursts, and the web client appends in-order live events without re-sorting the whole session on every frame.
