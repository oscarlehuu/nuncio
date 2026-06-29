---
"nuncio": patch
---

Redesigned the session transcript to match the Cursor IDE style: tool calls render as compact one-line rows (e.g. "Read foo.ts L10-20", "Ran `pnpm test`"), consecutive tool calls collapse into a single "Ran N files, M commands…" summary header that expands to reveal individual rows, and thinking blocks collapse to a single "Thought" row. File paths and commands use inline monospace pills, the "Done" status label is hidden by default (only "Failed" and "Running…" appear), and the overall spacing is tighter so long agent runs no longer fill the screen with full-width tool boxes.
