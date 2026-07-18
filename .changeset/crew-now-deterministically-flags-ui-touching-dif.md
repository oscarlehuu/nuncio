---
"nuncio": patch
---

Crew now deterministically flags UI-touching diffs: the workspace-diff evidence records which files affect the UI, the Reviewer and Foreman receive that signal in their context, and the run detail page badges a UI-touching diff with its file count.
