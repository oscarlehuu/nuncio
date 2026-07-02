---
"nuncio": patch
---

Messages queued while the agent is busy now survive a server restart — they are delivered as soon as the agent is next ready, instead of leaving a stuck "Queued" bubble that never sends.
