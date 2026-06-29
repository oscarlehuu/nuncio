---
"nuncio": patch
---

Fixed CLI handoff transcript sync — removed the 500-turn cap that prevented new Cursor IDE messages from appearing after refresh, and fixed the dedup so repeated tool calls are no longer duplicated. Split the AI's internal thinking that Cursor concatenates onto assistant messages into a separate collapsible "Thought for Xs" block (matching Cursor's UI). Moved repo/branch/Local into the composer footer row and auto-scroll to the latest message on session enter.
