---
"nuncio": minor
---

Added Claude as a first-class provider — pick `claude` when you create a session to run Claude Code natively through the Claude Agent SDK. It streams tokens and thinking live, lets you steer mid-task, interrupt a running turn, and resume the same conversation after a daemon restart; images paste into the composer, and tool actions route through the usual approval cards. Auth rides your logged-in Claude Code keychain automatically, or set `ANTHROPIC_API_KEY` — no OAuth flow inside Nuncio, and sessions stay isolated from your `~/.claude` config.
