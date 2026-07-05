---
"nuncio": patch
---

Resumed sessions no longer bury a Workbench grid tile under a wall of tool rows. A tool result whose tool call scrolled out of the tile's bounded event window — or was re-appended by a transcript refresh — is now dropped instead of rendered as an orphan block, so the tile shows the real conversation tail (assistant replies and tool calls) instead of a stack of disconnected tool results.
