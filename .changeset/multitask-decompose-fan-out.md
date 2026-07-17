---
"nuncio": minor
---

Multitask mode now decomposes and fans out: a multitask session whose engine can split a goal (Nuncio Engine's Mock does this deterministically) turns your goal into up to five independent subtasks and spawns one child session per subtask — each in its own worktree, inheriting the parent's model. The parent stays working until every child settles, and the transcript shows the coordinator split plus a live board of child digests and lineage chips; one child failing shows an error on its card without sinking the others.
