---
"nuncio": minor
---

Nuncio Engine sessions now confine their file writes and shell commands to the session's own workspace by default whenever they have a project or worktree, so an agent can no longer accidentally write into an unrelated folder. Ad-hoc chats are unaffected, and you can turn it off in Settings (Nuncio Engine workspace confinement).
