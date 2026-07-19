---
"nuncio": minor
---

Nuncio Engine sessions can now opt into harness-owned context compaction: your plan, latest verify result, open task chips, reproduction gates, and recent instructions survive compaction word-for-word instead of depending on a summarizer, a configurable cheap model writes the narrative part, and the agent can re-read compacted turns from the durable history with the new read_session_history tool. Configure it in Settings under Nuncio Engine; any failure automatically falls back to Pi's built-in compaction.
