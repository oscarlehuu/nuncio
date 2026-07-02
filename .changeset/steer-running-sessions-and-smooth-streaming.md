---
"nuncio": minor
---

Made chat usable for real work: steer a **running** session (Pi injects the message into the live run before its next model call; other providers queue and auto-send on idle), a true Stop that interrupts the run in place, and much smoother streaming — adaptive text reveal instead of the fixed 40 chars/sec crawl, coalesced token persistence, one multiplexed SSE connection for the whole grid, memoized streaming markdown (mermaid waits for its fence to close), and IME-safe inputs for Vietnamese typing.
