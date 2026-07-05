---
"nuncio": patch
---

Fixed Codex chat rendering as an unbroken wall of text: when a turn's message arrives as several agent-message items, Nuncio now inserts a paragraph break at each item boundary so sections no longer run together (e.g. "…setting đó.Tôi sẽ…"). The chat display stays engine-agnostic — Codex now produces the same well-formed markdown other providers already do.
