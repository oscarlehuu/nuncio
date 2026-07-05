---
"nuncio": patch
---

Resumed Pi sessions no longer show a duplicate copy of your prompt, an empty grid tile, or a broken image attachment. A transcript refresh was re-appending the original prompt (image-stripped) and a burst of tool results whose on-disk payload differed from what streamed live; those now dedupe by stable identity (message text, tool call id) instead of exact payload. The transcript renderer is also hardened to drop an already-closed tool result and collapse a repeated user bubble, so sessions that were already corrupted render cleanly too — keeping the original image-bearing message.
