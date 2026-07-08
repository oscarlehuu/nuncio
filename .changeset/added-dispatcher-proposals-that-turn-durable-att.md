---
"nuncio": minor
---

Added dispatcher proposals that turn durable attention signals into one-tap queued tasks.

Every evening around 20:05, Nuncio drafts tomorrow's queue from open attention, broken loops, stale PR reviews, failed verifies, failed runs, and starved tasks. Approving the proposal is idempotent: retries return the same queued task ids instead of creating duplicates.
