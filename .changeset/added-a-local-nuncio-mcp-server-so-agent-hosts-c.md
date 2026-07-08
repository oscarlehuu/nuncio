---
"nuncio": minor
---

Added a local Nuncio MCP server so agent hosts can inspect sessions, timelines, attention, fleet health, and loops from the running daemon over stdio.

The MCP surface exposes eight tools and keeps mutations constrained to enqueueing a task or pausing a loop; it is a thin daemon proxy and never calls model APIs.
